using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;
using Npgsql;

namespace ArchiveMail.Api.Property;

public sealed record PropertyPaymentRecord(
    string Id,string OwnerUserId,string PropertyId,string? LeaseId,string? ChargeId,string PropertyName,
    string Provider,string Method,long AmountCents,string Currency,string Status,string? ExternalId,
    string? ProviderTransactionId,string? CheckoutUrl,string? Reference,string? PaidAt,string? FailureReason,
    string Notes,string CreatedAt,string UpdatedAt);

public sealed class PropertyPaymentGateway(
    NpgsqlDataSource database,
    AppSettingsService settings,
    IHttpClientFactory clients)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<object> CheckoutAsync(string paymentId,string userId,string returnOrigin,CancellationToken token)
    {
        var payment=await LoadAccessibleAsync(paymentId,userId,token);
        if(payment.Status is "succeeded" or "refunded")throw new InvalidOperationException("This payment is already complete");
        return payment.Provider switch
        {
            "stripe"=>await CreateStripeCheckoutAsync(payment,returnOrigin,token),
            "paypal"=>await CreatePayPalOrderAsync(payment,returnOrigin,token),
            "zelle"=>await ZelleInstructionsAsync(payment,token),
            "apple_cash"=>await AppleCashInstructionsAsync(payment,token),
            "manual"=>new{payment,action="instructions",url=(string?)null,instructions="Record the receipt or check reference, then mark this payment successful after the funds are verified."},
            _=>throw new ArgumentException($"Unsupported payment provider: {payment.Provider}")
        };
    }

    public async Task<PropertyPaymentRecord> SyncAsync(string paymentId,string userId,CancellationToken token)
    {
        var payment=await LoadAccessibleAsync(paymentId,userId,token);
        return payment.Provider switch
        {
            "stripe"=>await SyncStripeAsync(payment,token),
            "paypal"=>await SyncPayPalAsync(payment,token),
            _=>payment
        };
    }

    public async Task<object> RefundAsync(string paymentId,string userId,long? requestedAmount,string reason,CancellationToken token)
    {
        var payment=await LoadOwnedAsync(paymentId,userId,token);
        if(payment.Status is not ("succeeded" or "refunded"))throw new InvalidOperationException("Only successful payments can be refunded");
        // Count what has already been refunded so repeated partial refunds cannot exceed the payment.
        // Stripe and PayPal reject an over-refund themselves, but zelle/apple_cash/manual have no such backstop.
        var alreadyRefunded=await RefundedTotalAsync(payment.Id,token);
        var amount=PropertyPaymentRules.ValidateRefundAmount(requestedAmount,payment.AmountCents,alreadyRefunded);
        string providerRefundId;
        if(payment.Provider=="stripe")providerRefundId=await RefundStripeAsync(payment,amount,token);
        else if(payment.Provider=="paypal")providerRefundId=await RefundPayPalAsync(payment,amount,token);
        else providerRefundId=$"local-{Guid.NewGuid()}";
        var fullyRefunded=PropertyPaymentRules.IsFullRefund(amount,payment.AmountCents,alreadyRefunded);
        var updated=await UpdateAsync(payment,fullyRefunded?"refunded":"succeeded",payment.Method,
            payment.ProviderTransactionId,payment.ExternalId,payment.CheckoutUrl,payment.PaidAt,null,payment.Reference,token);
        await RecordRefundLedgerAsync(updated,amount,reason,providerRefundId,token);
        return new{payment=updated,amountCents=amount,providerRefundId,
            refundedToDateCents=alreadyRefunded+amount,
            remainingRefundableCents=PropertyPaymentRules.RemainingRefundable(payment.AmountCents,alreadyRefunded+amount)};
    }

    /// <summary>Total already refunded against a payment, read back from the ledger (refunds are negative).</summary>
    private async Task<long> RefundedTotalAsync(string paymentId,CancellationToken token)
    {
        await using var command=database.CreateCommand(
            "SELECT COALESCE(SUM(-amount_cents),0) FROM property_ledger_entries WHERE payment_id=$1 AND entry_type='refund'");
        command.Parameters.AddWithValue(paymentId);
        return Convert.ToInt64(await command.ExecuteScalarAsync(token));
    }

    public JsonDocument VerifyStripeWebhook(byte[] rawBody,string? signatureHeader)
    {
        var secret=settings.Current().PropertyIntegrationsValue.StripeWebhookSecret;
        if(string.IsNullOrWhiteSpace(secret))throw new InvalidOperationException("Stripe webhook secret is not configured");
        if(string.IsNullOrWhiteSpace(signatureHeader))throw new ArgumentException("Stripe signature is missing");
        string? timestamp=null;var signatures=new List<string>();
        foreach(var item in signatureHeader.Split(','))
        {var pair=item.Trim().Split('=',2);if(pair.Length!=2)continue;if(pair[0]=="t")timestamp=pair[1];else if(pair[0]=="v1")signatures.Add(pair[1]);}
        if(!long.TryParse(timestamp,out var seconds)||Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds()-seconds)>300||signatures.Count==0)
            throw new ArgumentException("Stripe signature is invalid or expired");
        var signed=Encoding.UTF8.GetBytes($"{timestamp}.{Encoding.UTF8.GetString(rawBody)}");
        var expected=HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret),signed);
        var valid=signatures.Any(value=>TryHex(value,out var actual)&&actual.Length==expected.Length&&CryptographicOperations.FixedTimeEquals(actual,expected));
        if(!valid)throw new ArgumentException("Stripe signature verification failed");
        return JsonDocument.Parse(rawBody);
    }

    public async Task VerifyPayPalWebhookAsync(IHeaderDictionary headers,JsonElement payload,CancellationToken token)
    {
        var config=settings.Current().PropertyIntegrationsValue;
        if(string.IsNullOrWhiteSpace(config.PaypalWebhookId))throw new InvalidOperationException("PayPal webhook ID is not configured");
        var accessToken=await PayPalTokenAsync(token);
        var body=JsonSerializer.SerializeToElement(new{
            auth_algo=headers["PAYPAL-AUTH-ALGO"].ToString(),cert_url=headers["PAYPAL-CERT-URL"].ToString(),
            transmission_id=headers["PAYPAL-TRANSMISSION-ID"].ToString(),transmission_sig=headers["PAYPAL-TRANSMISSION-SIG"].ToString(),
            transmission_time=headers["PAYPAL-TRANSMISSION-TIME"].ToString(),webhook_id=config.PaypalWebhookId,webhook_event=payload});
        var response=await SendJsonAsync(HttpMethod.Post,$"{PayPalBaseUrl()}/v1/notifications/verify-webhook-signature",body,accessToken,null,token);
        if(Text(response.RootElement,"verification_status")!="SUCCESS")throw new ArgumentException("PayPal webhook signature verification failed");
    }

    public bool VerifyTwilioWebhook(string requestUrl,IReadOnlyDictionary<string,string> form,string? signature)
    {
        var secret=settings.Current().PropertyIntegrationsValue.TwilioAuthToken;
        if(string.IsNullOrWhiteSpace(secret))throw new InvalidOperationException("Twilio auth token is not configured");
        if(string.IsNullOrWhiteSpace(signature))return false;
        var source=new StringBuilder(requestUrl);foreach(var pair in form.OrderBy(value=>value.Key,StringComparer.Ordinal))source.Append(pair.Key).Append(pair.Value);
        var expected=Convert.ToBase64String(HMACSHA1.HashData(Encoding.UTF8.GetBytes(secret),Encoding.UTF8.GetBytes(source.ToString())));
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected),Encoding.ASCII.GetBytes(signature));
    }

    public async Task<bool> ApplyProviderEventAsync(string provider,string eventType,string payloadJson,CancellationToken token)
    {
        using var document=JsonDocument.Parse(payloadJson);var root=document.RootElement;
        var resource=provider=="stripe"?NestedObject(root,"data","object"):Object(root,"resource");
        if(resource is null)return false;
        var paymentId=provider=="stripe"?StripePaymentId(resource.Value):PayPalPaymentId(resource.Value);
        var reference=provider=="stripe"?StringOrObjectId(resource.Value,"payment_intent")??Text(resource.Value,"id"):PayPalProviderReference(resource.Value);
        var payment=paymentId is not null?await LoadSystemAsync(paymentId,token):reference is not null?await FindByProviderReferenceAsync(provider,reference,token):null;
        if(payment is null||payment.Provider!=provider)return false;
        string? status=null,transaction=payment.ProviderTransactionId,failure=null;var paidAt=payment.PaidAt;
        if(provider=="stripe")
        {
            transaction=StringOrObjectId(resource.Value,"payment_intent")??transaction;
            if(eventType is "checkout.session.completed" or "checkout.session.async_payment_succeeded")
            {status=Text(resource.Value,"payment_status")=="paid"||eventType.EndsWith("succeeded",StringComparison.Ordinal)?"succeeded":"processing";if(status=="succeeded")paidAt=Now();}
            else if(eventType is "checkout.session.async_payment_failed" or "payment_intent.payment_failed")
            {status="failed";failure=NestedText(resource.Value,"last_payment_error","message")??"Payment provider reported a failure";}
            else if(eventType=="charge.refunded")status=Number(resource.Value,"amount_refunded")>=payment.AmountCents?"refunded":"succeeded";
        }
        else
        {
            if(eventType.StartsWith("PAYMENT.CAPTURE.",StringComparison.Ordinal))transaction=Text(resource.Value,"id")??transaction;
            if(eventType is "PAYMENT.CAPTURE.COMPLETED" or "CHECKOUT.ORDER.COMPLETED"){status="succeeded";paidAt=Now();}
            else if(eventType=="CHECKOUT.ORDER.APPROVED")status="processing";
            else if(eventType is "PAYMENT.CAPTURE.DENIED" or "CHECKOUT.PAYMENT-APPROVAL.REVERSED"){status="failed";failure=$"PayPal reported {eventType}";}
            else if(eventType is "PAYMENT.CAPTURE.REFUNDED" or "PAYMENT.CAPTURE.REVERSED")status="refunded";
        }
        if(status is null)return true;
        await UpdateAsync(payment,status,payment.Method,transaction,payment.ExternalId,payment.CheckoutUrl,paidAt,failure,payment.Reference,token);
        return true;
    }

    private async Task<object> CreateStripeCheckoutAsync(PropertyPaymentRecord payment,string origin,CancellationToken token)
    {
        var secret=settings.Current().PropertyIntegrationsValue.StripeSecretKey;if(string.IsNullOrWhiteSpace(secret))throw new InvalidOperationException("Stripe is not configured");
        var form=new Dictionary<string,string>{["mode"]="payment",["success_url"]=$"{origin}/properties?payment={Uri.EscapeDataString(payment.Id)}&result=success",["cancel_url"]=$"{origin}/properties?payment={Uri.EscapeDataString(payment.Id)}&result=cancelled",["client_reference_id"]=payment.Id,["metadata[property_payment_id]"]=payment.Id,["payment_intent_data[metadata][property_payment_id]"]=payment.Id,["line_items[0][quantity]"]="1",["line_items[0][price_data][currency]"]=payment.Currency.ToLowerInvariant(),["line_items[0][price_data][unit_amount]"]=payment.AmountCents.ToString(CultureInfo.InvariantCulture),["line_items[0][price_data][product_data][name]"]=$"Rent payment - {payment.PropertyName}"};
        using var request=new HttpRequestMessage(HttpMethod.Post,"https://api.stripe.com/v1/checkout/sessions"){Content=new FormUrlEncodedContent(form)};request.Headers.Authorization=new("Bearer",secret);request.Headers.TryAddWithoutValidation("Idempotency-Key",$"property-payment-{payment.Id}");
        using var response=await clients.CreateClient("external").SendAsync(request,token);using var json=await ReadProviderJsonAsync(response,"Stripe could not create a Checkout session",token);
        var external=RequiredText(json.RootElement,"id","Stripe did not return a Checkout session ID");var url=RequiredText(json.RootElement,"url","Stripe did not return a Checkout URL");
        var updated=await UpdateAsync(payment,"processing",payment.Method,payment.ProviderTransactionId,external,url,payment.PaidAt,null,payment.Reference,token);return new{payment=updated,action="redirect",url,instructions=(string?)null};
    }

    private async Task<object> CreatePayPalOrderAsync(PropertyPaymentRecord payment,string origin,CancellationToken token)
    {
        var accessToken=await PayPalTokenAsync(token);var body=JsonSerializer.SerializeToElement(new{intent="CAPTURE",purchase_units=new[]{new{reference_id=payment.Id,custom_id=payment.Id,description=$"Rent payment - {payment.PropertyName}",amount=new{currency_code=payment.Currency,value=(payment.AmountCents/100m).ToString("0.00",CultureInfo.InvariantCulture)}}},payment_source=new{paypal=new{experience_context=new{user_action="PAY_NOW",return_url=$"{origin}/properties?payment={Uri.EscapeDataString(payment.Id)}&result=success",cancel_url=$"{origin}/properties?payment={Uri.EscapeDataString(payment.Id)}&result=cancelled"}}}});
        using var json=await SendJsonAsync(HttpMethod.Post,$"{PayPalBaseUrl()}/v2/checkout/orders",body,accessToken,$"property-payment-{payment.Id}",token);var external=RequiredText(json.RootElement,"id","PayPal did not return an order ID");
        string? url=null;if(json.RootElement.TryGetProperty("links",out var links)&&links.ValueKind==JsonValueKind.Array)foreach(var link in links.EnumerateArray())if(Text(link,"rel") is "payer-action" or "approve"){url=Text(link,"href");break;}
        if(string.IsNullOrWhiteSpace(url))throw new InvalidOperationException("PayPal did not return an approval link");var updated=await UpdateAsync(payment,"processing",payment.Method,payment.ProviderTransactionId,external,url,payment.PaidAt,null,payment.Reference,token);return new{payment=updated,action="redirect",url,instructions=(string?)null};
    }

    private async Task<PropertyPaymentRecord> SyncStripeAsync(PropertyPaymentRecord payment,CancellationToken token)
    {
        var secret=settings.Current().PropertyIntegrationsValue.StripeSecretKey;if(string.IsNullOrWhiteSpace(secret))throw new InvalidOperationException("Stripe is not configured");if(string.IsNullOrWhiteSpace(payment.ExternalId))throw new InvalidOperationException("This Stripe payment has no Checkout session");
        using var request=new HttpRequestMessage(HttpMethod.Get,$"https://api.stripe.com/v1/checkout/sessions/{Uri.EscapeDataString(payment.ExternalId)}?expand[]=payment_intent.latest_charge.payment_method_details");request.Headers.Authorization=new("Bearer",secret);using var response=await clients.CreateClient("external").SendAsync(request,token);using var json=await ReadProviderJsonAsync(response,"Stripe payment status could not be loaded",token);
        var state=Text(json.RootElement,"payment_status")=="paid"?"succeeded":Text(json.RootElement,"status")=="expired"?"cancelled":"processing";var transaction=StringOrObjectId(json.RootElement,"payment_intent")??payment.ProviderTransactionId;
        return await UpdateAsync(payment,state,payment.Method,transaction,payment.ExternalId,payment.CheckoutUrl,state=="succeeded"?Now():payment.PaidAt,null,payment.Reference,token);
    }

    private async Task<PropertyPaymentRecord> SyncPayPalAsync(PropertyPaymentRecord payment,CancellationToken token)
    {
        if(string.IsNullOrWhiteSpace(payment.ExternalId))throw new InvalidOperationException("This PayPal payment has no order");var accessToken=await PayPalTokenAsync(token);using var initial=await PayPalOrderAsync(accessToken,payment.ExternalId,token);JsonDocument current=initial;
        if(Text(current.RootElement,"status")=="APPROVED")current=await SendJsonAsync(HttpMethod.Post,$"{PayPalBaseUrl()}/v2/checkout/orders/{Uri.EscapeDataString(payment.ExternalId)}/capture",JsonSerializer.SerializeToElement(new{}),accessToken,$"capture-{payment.Id}",token);
        using(current){var providerState=Text(current.RootElement,"status");var state=providerState=="COMPLETED"?"succeeded":providerState=="VOIDED"?"cancelled":"processing";return await UpdateAsync(payment,state,"paypal",PayPalCaptureId(current.RootElement)??payment.ProviderTransactionId,payment.ExternalId,payment.CheckoutUrl,state=="succeeded"?Now():payment.PaidAt,null,payment.Reference,token);}
    }

    private async Task<object> ZelleInstructionsAsync(PropertyPaymentRecord payment,CancellationToken token)
    {var config=settings.Current().PropertyIntegrationsValue;if(string.IsNullOrWhiteSpace(config.ZelleRecipient))throw new InvalidOperationException("Zelle recipient is not configured");var reference=payment.Reference??$"RENT-{payment.Id[..8].ToUpperInvariant()}";var updated=await UpdateAsync(payment,"pending",payment.Method,payment.ProviderTransactionId,payment.ExternalId,payment.CheckoutUrl,payment.PaidAt,null,reference,token);return new{payment=updated,action="instructions",url=(string?)null,instructions=$"Send {(payment.AmountCents/100m).ToString("C",CultureInfo.GetCultureInfo("en-US"))} to {config.ZelleRecipient}. Use {reference} in the memo. {config.ZelleNote}".Trim()};}

    /// <summary>
    /// Apple Cash is a person-to-person transfer sent from the tenant's Wallet or Messages. Apple exposes
    /// no merchant API for receiving it, so this mirrors the Zelle flow: issue a memo reference the tenant
    /// quotes when sending, and leave the payment pending until a manager confirms the funds arrived.
    /// </summary>
    private async Task<object> AppleCashInstructionsAsync(PropertyPaymentRecord payment,CancellationToken token)
    {
        var config=settings.Current().PropertyIntegrationsValue;
        if(string.IsNullOrWhiteSpace(config.AppleCashRecipient))throw new InvalidOperationException("Apple Cash recipient is not configured");
        var reference=payment.Reference??$"RENT-{payment.Id[..8].ToUpperInvariant()}";
        var updated=await UpdateAsync(payment,"pending",payment.Method,payment.ProviderTransactionId,payment.ExternalId,payment.CheckoutUrl,payment.PaidAt,null,reference,token);
        var amount=(payment.AmountCents/100m).ToString("C",CultureInfo.GetCultureInfo("en-US"));
        return new{payment=updated,action="instructions",url=(string?)null,
            instructions=$"Open Messages on your iPhone or iPad, start a conversation with {config.AppleCashRecipient}, tap Apple Cash, and send {amount}. Put {reference} in the message so the payment can be matched. {config.AppleCashNote}".Trim()};
    }

    private async Task<string> RefundStripeAsync(PropertyPaymentRecord payment,long amount,CancellationToken token)
    {var secret=settings.Current().PropertyIntegrationsValue.StripeSecretKey;if(string.IsNullOrWhiteSpace(secret))throw new InvalidOperationException("Stripe is not configured");var transaction=payment.ProviderTransactionId;if(string.IsNullOrWhiteSpace(transaction)&&payment.ExternalId is not null){using var request=new HttpRequestMessage(HttpMethod.Get,$"https://api.stripe.com/v1/checkout/sessions/{Uri.EscapeDataString(payment.ExternalId)}");request.Headers.Authorization=new("Bearer",secret);using var response=await clients.CreateClient("external").SendAsync(request,token);using var session=await ReadProviderJsonAsync(response,"Stripe payment could not be loaded",token);transaction=StringOrObjectId(session.RootElement,"payment_intent");}if(string.IsNullOrWhiteSpace(transaction))throw new InvalidOperationException("Stripe payment transaction was not found");using var refund=new HttpRequestMessage(HttpMethod.Post,"https://api.stripe.com/v1/refunds"){Content=new FormUrlEncodedContent(new Dictionary<string,string>{{"payment_intent",transaction},{"amount",amount.ToString(CultureInfo.InvariantCulture)},{"metadata[property_payment_id]",payment.Id}})};refund.Headers.Authorization=new("Bearer",secret);refund.Headers.TryAddWithoutValidation("Idempotency-Key",$"property-refund-{payment.Id}-{amount}");using var result=await clients.CreateClient("external").SendAsync(refund,token);using var json=await ReadProviderJsonAsync(result,"Stripe refund failed",token);return RequiredText(json.RootElement,"id","Stripe did not return a refund ID");}

    private async Task<string> RefundPayPalAsync(PropertyPaymentRecord payment,long amount,CancellationToken token)
    {var accessToken=await PayPalTokenAsync(token);if(string.IsNullOrWhiteSpace(payment.ExternalId))throw new InvalidOperationException("PayPal order was not found");using var order=await PayPalOrderAsync(accessToken,payment.ExternalId,token);var capture=PayPalCaptureId(order.RootElement)??payment.ProviderTransactionId;if(string.IsNullOrWhiteSpace(capture))throw new InvalidOperationException("PayPal capture was not found");var body=JsonSerializer.SerializeToElement(new{amount=new{value=(amount/100m).ToString("0.00",CultureInfo.InvariantCulture),currency_code=payment.Currency}});using var json=await SendJsonAsync(HttpMethod.Post,$"{PayPalBaseUrl()}/v2/payments/captures/{Uri.EscapeDataString(capture)}/refund",body,accessToken,$"property-refund-{payment.Id}-{amount}",token);return RequiredText(json.RootElement,"id","PayPal did not return a refund ID");}

    private async Task<string> PayPalTokenAsync(CancellationToken token)
    {var config=settings.Current().PropertyIntegrationsValue;if(string.IsNullOrWhiteSpace(config.PaypalClientId)||string.IsNullOrWhiteSpace(config.PaypalClientSecret))throw new InvalidOperationException("PayPal is not configured");using var request=new HttpRequestMessage(HttpMethod.Post,$"{PayPalBaseUrl()}/v1/oauth2/token"){Content=new FormUrlEncodedContent(new Dictionary<string,string>{{"grant_type","client_credentials"}})};request.Headers.Authorization=new AuthenticationHeaderValue("Basic",Convert.ToBase64String(Encoding.UTF8.GetBytes($"{config.PaypalClientId}:{config.PaypalClientSecret}")));using var response=await clients.CreateClient("external").SendAsync(request,token);using var json=await ReadProviderJsonAsync(response,"PayPal authorization failed",token);return RequiredText(json.RootElement,"access_token","PayPal did not return an access token");}
    private Task<JsonDocument> PayPalOrderAsync(string accessToken,string orderId,CancellationToken token)=>SendJsonAsync(HttpMethod.Get,$"{PayPalBaseUrl()}/v2/checkout/orders/{Uri.EscapeDataString(orderId)}",null,accessToken,null,token);
    private string PayPalBaseUrl()=>settings.Current().PropertyIntegrationsValue.PaypalEnvironment=="live"?"https://api-m.paypal.com":"https://api-m.sandbox.paypal.com";

    private async Task<JsonDocument> SendJsonAsync(HttpMethod method,string url,JsonElement? body,string bearer,string? idempotency,CancellationToken token)
    {using var request=new HttpRequestMessage(method,url);request.Headers.Authorization=new("Bearer",bearer);if(idempotency is not null)request.Headers.TryAddWithoutValidation("PayPal-Request-Id",idempotency);if(body is not null)request.Content=new StringContent(body.Value.GetRawText(),Encoding.UTF8,"application/json");using var response=await clients.CreateClient("external").SendAsync(request,token);return await ReadProviderJsonAsync(response,"Payment provider request failed",token);}
    private static async Task<JsonDocument> ReadProviderJsonAsync(HttpResponseMessage response,string fallback,CancellationToken token)
    {var content=await response.Content.ReadAsStringAsync(token);JsonDocument json;try{json=JsonDocument.Parse(string.IsNullOrWhiteSpace(content)?"{}":content);}catch{json=JsonDocument.Parse("{}");}if(response.IsSuccessStatusCode)return json;var message=NestedText(json.RootElement,"error","message")??Text(json.RootElement,"message")??Text(json.RootElement,"error_description")??$"{fallback} ({(int)response.StatusCode})";json.Dispose();throw new InvalidOperationException(message);}

    private async Task<PropertyPaymentRecord> UpdateAsync(PropertyPaymentRecord payment,string status,string method,string? transaction,string? external,string? checkout,string? paidAt,string? failure,string? reference,CancellationToken token)
    {const string sql="UPDATE property_payments SET status=$2,method=$3,provider_transaction_id=$4,external_id=$5,checkout_url=$6,paid_at=$7,failure_reason=$8,reference=$9,updated_at=$10 WHERE id=$1 RETURNING updated_at";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(payment.Id);command.Parameters.AddWithValue(status);command.Parameters.AddWithValue(method);Add(command,transaction);Add(command,external);Add(command,checkout);Add(command,paidAt);Add(command,failure);Add(command,reference);command.Parameters.AddWithValue(Now());var updated=Convert.ToString(await command.ExecuteScalarAsync(token))!;var result=payment with{Status=status,Method=method,ProviderTransactionId=transaction,ExternalId=external,CheckoutUrl=checkout,PaidAt=paidAt,FailureReason=failure,Reference=reference,UpdatedAt=updated};if(status=="succeeded")await RecordSuccessfulPaymentAsync(result,token);return result;}
    private async Task RecordSuccessfulPaymentAsync(PropertyPaymentRecord payment,CancellationToken token)
    {
        var now=Now();await using var connection=await database.OpenConnectionAsync(token);await using var transaction=await connection.BeginTransactionAsync(token);
        await using(var ledger=new NpgsqlCommand("INSERT INTO property_ledger_entries(id,organization_id,property_id,lease_id,charge_id,payment_id,entry_type,amount_cents,description,effective_at,unique_key,created_at) SELECT $1,p.organization_id,$2,$3,$4,$5,'payment',$6,$7,$8,$9,$10 FROM managed_properties p WHERE p.id=$2 ON CONFLICT(unique_key) DO NOTHING",connection,transaction)){ledger.Parameters.AddWithValue(Guid.NewGuid().ToString());ledger.Parameters.AddWithValue(payment.PropertyId);Add(ledger,payment.LeaseId);Add(ledger,payment.ChargeId);ledger.Parameters.AddWithValue(payment.Id);ledger.Parameters.AddWithValue(payment.AmountCents);ledger.Parameters.AddWithValue($"Payment received - {payment.PropertyName}");ledger.Parameters.AddWithValue(payment.PaidAt??now);ledger.Parameters.AddWithValue($"payment:{payment.Id}");ledger.Parameters.AddWithValue(now);await ledger.ExecuteNonQueryAsync(token);}
        await using(var receipt=new NpgsqlCommand("INSERT INTO property_receipts(id,payment_id,receipt_number,amount_cents,currency,paid_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(payment_id) DO NOTHING",connection,transaction)){receipt.Parameters.AddWithValue(Guid.NewGuid().ToString());receipt.Parameters.AddWithValue(payment.Id);receipt.Parameters.AddWithValue($"AM-{DateTime.UtcNow:yyyyMMdd}-{payment.Id[..8].ToUpperInvariant()}");receipt.Parameters.AddWithValue(payment.AmountCents);receipt.Parameters.AddWithValue(payment.Currency);receipt.Parameters.AddWithValue(payment.PaidAt??now);receipt.Parameters.AddWithValue(now);await receipt.ExecuteNonQueryAsync(token);}
        if(payment.ChargeId is not null)
        {
            // Never allocate more than the charge still owes, so an overpayment cannot make a charge
            // look over-settled in the ledger.
            long outstanding;
            await using(var balance=new NpgsqlCommand("SELECT c.amount_cents-COALESCE((SELECT SUM(a.amount_cents) FROM property_payment_allocations a WHERE a.charge_id=c.id),0) FROM property_rent_charges c WHERE c.id=$1",connection,transaction))
            {balance.Parameters.AddWithValue(payment.ChargeId);outstanding=Convert.ToInt64(await balance.ExecuteScalarAsync(token));}
            var allocated=PropertyPaymentRules.AllocationCents(payment.AmountCents,outstanding);
            if(allocated>0)
            {
                await using var allocation=new NpgsqlCommand("INSERT INTO property_payment_allocations(id,payment_id,charge_id,amount_cents,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(payment_id,charge_id) DO NOTHING",connection,transaction);
                allocation.Parameters.AddWithValue(Guid.NewGuid().ToString());allocation.Parameters.AddWithValue(payment.Id);allocation.Parameters.AddWithValue(payment.ChargeId);allocation.Parameters.AddWithValue(allocated);allocation.Parameters.AddWithValue(now);
                await allocation.ExecuteNonQueryAsync(token);
            }
        }
        await transaction.CommitAsync(token);
    }
    private async Task RecordRefundLedgerAsync(PropertyPaymentRecord payment,long amount,string reason,string refundId,CancellationToken token)
    {await using var command=database.CreateCommand("INSERT INTO property_ledger_entries(id,organization_id,property_id,lease_id,charge_id,payment_id,entry_type,amount_cents,description,effective_at,unique_key,created_at) SELECT $1,p.organization_id,$2,$3,$4,$5,'refund',$6,$7,$8,$9,$8 FROM managed_properties p WHERE p.id=$2 ON CONFLICT(unique_key) DO NOTHING");command.Parameters.AddWithValue(Guid.NewGuid().ToString());command.Parameters.AddWithValue(payment.PropertyId);Add(command,payment.LeaseId);Add(command,payment.ChargeId);command.Parameters.AddWithValue(payment.Id);command.Parameters.AddWithValue(-amount);command.Parameters.AddWithValue($"Refund - {reason}");command.Parameters.AddWithValue(Now());command.Parameters.AddWithValue($"refund:{payment.Id}:{refundId}");await command.ExecuteNonQueryAsync(token);}

    private Task<PropertyPaymentRecord> LoadOwnedAsync(string id,string owner,CancellationToken token)=>LoadAsync(id,"x.owner_user_id=$2",owner,token);
    private Task<PropertyPaymentRecord> LoadAccessibleAsync(string id,string user,CancellationToken token)=>LoadAsync(id,"(x.owner_user_id=$2 OR EXISTS(SELECT 1 FROM property_leases l JOIN property_tenants t ON t.id=l.tenant_id WHERE l.id=x.lease_id AND t.linked_user_id=$2))",user,token);
    private async Task<PropertyPaymentRecord> LoadAsync(string id,string where,string user,CancellationToken token){await using var command=database.CreateCommand($"SELECT x.id,x.owner_user_id,x.property_id,x.lease_id,x.charge_id,p.name,x.provider,x.method,x.amount_cents,x.currency,x.status,x.external_id,x.provider_transaction_id,x.checkout_url,x.reference,x.paid_at,x.failure_reason,x.notes,x.created_at,x.updated_at FROM property_payments x JOIN managed_properties p ON p.id=x.property_id WHERE x.id=$1 AND {where}");command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(user);await using var reader=await command.ExecuteReaderAsync(token);if(!await reader.ReadAsync(token))throw new MailNotFoundException("Payment not found");return Read(reader);}
    private async Task<PropertyPaymentRecord?> LoadSystemAsync(string id,CancellationToken token){await using var command=database.CreateCommand("SELECT x.id,x.owner_user_id,x.property_id,x.lease_id,x.charge_id,p.name,x.provider,x.method,x.amount_cents,x.currency,x.status,x.external_id,x.provider_transaction_id,x.checkout_url,x.reference,x.paid_at,x.failure_reason,x.notes,x.created_at,x.updated_at FROM property_payments x JOIN managed_properties p ON p.id=x.property_id WHERE x.id=$1");command.Parameters.AddWithValue(id);await using var reader=await command.ExecuteReaderAsync(token);return await reader.ReadAsync(token)?Read(reader):null;}
    private async Task<PropertyPaymentRecord?> FindByProviderReferenceAsync(string provider,string reference,CancellationToken token){await using var command=database.CreateCommand("SELECT x.id,x.owner_user_id,x.property_id,x.lease_id,x.charge_id,p.name,x.provider,x.method,x.amount_cents,x.currency,x.status,x.external_id,x.provider_transaction_id,x.checkout_url,x.reference,x.paid_at,x.failure_reason,x.notes,x.created_at,x.updated_at FROM property_payments x JOIN managed_properties p ON p.id=x.property_id WHERE x.provider=$1 AND (x.external_id=$2 OR x.provider_transaction_id=$2) LIMIT 1");command.Parameters.AddWithValue(provider);command.Parameters.AddWithValue(reference);await using var reader=await command.ExecuteReaderAsync(token);return await reader.ReadAsync(token)?Read(reader):null;}
    private static PropertyPaymentRecord Read(NpgsqlDataReader r)=>new(r.GetString(0),r.GetString(1),r.GetString(2),Null(r,3),Null(r,4),r.GetString(5),r.GetString(6),r.GetString(7),r.GetInt64(8),r.GetString(9),r.GetString(10),Null(r,11),Null(r,12),Null(r,13),Null(r,14),Null(r,15),Null(r,16),r.GetString(17),r.GetString(18),r.GetString(19));
    private static string? Null(NpgsqlDataReader r,int index)=>r.IsDBNull(index)?null:r.GetString(index);
    private static void Add(NpgsqlCommand command,object? value)=>command.Parameters.AddWithValue(value??DBNull.Value);
    private static string Now()=>DateTimeOffset.UtcNow.ToString("O");
    private static bool TryHex(string value,out byte[] bytes){try{bytes=Convert.FromHexString(value);return true;}catch{bytes=[];return false;}}
    private static string RequiredText(JsonElement value,string name,string error)=>Text(value,name)??throw new InvalidOperationException(error);
    private static string? Text(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind==JsonValueKind.String?item.GetString():null;
    private static long Number(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.TryGetInt64(out var number)?number:0;
    private static string? NestedText(JsonElement value,string parent,string name)=>Object(value,parent) is{} item?Text(item,name):null;
    private static JsonElement? NestedObject(JsonElement value,string parent,string name)=>Object(value,parent) is{} item?Object(item,name):null;
    private static JsonElement? Object(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind==JsonValueKind.Object?item:null;
    private static string? StringOrObjectId(JsonElement value,string name)=>Text(value,name)??(Object(value,name) is{} item?Text(item,"id"):null);
    private static string? StripePaymentId(JsonElement resource)=>NestedText(resource,"metadata","property_payment_id")??Text(resource,"client_reference_id");
    private static string? PayPalPaymentId(JsonElement resource){var direct=Text(resource,"custom_id")??Text(resource,"invoice_id");if(direct is not null)return direct;if(resource.TryGetProperty("purchase_units",out var units)&&units.ValueKind==JsonValueKind.Array&&units.GetArrayLength()>0)return Text(units[0],"custom_id")??Text(units[0],"reference_id");return null;}
    private static string? PayPalProviderReference(JsonElement resource){var supplementary=Object(resource,"supplementary_data");var related=supplementary is{} value?Object(value,"related_ids"):null;return related is{} ids?Text(ids,"order_id")??Text(ids,"capture_id")??Text(resource,"id"):Text(resource,"id");}
    private static string? PayPalCaptureId(JsonElement order){if(!order.TryGetProperty("purchase_units",out var units)||units.ValueKind!=JsonValueKind.Array||units.GetArrayLength()==0)return null;var payments=Object(units[0],"payments");if(payments is null||!payments.Value.TryGetProperty("captures",out var captures)||captures.ValueKind!=JsonValueKind.Array||captures.GetArrayLength()==0)return null;return Text(captures[0],"id");}
}
