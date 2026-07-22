using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var auth = app.MapGroup("/api/auth").WithTags("Authentication");

        auth.MapPost("/login", async (
            LoginRequest request,
            HttpContext context,
            AuthService service,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(request.Username) || request.Pin.Length is < 4 or > 128)
                return Results.BadRequest(new { error = "Enter a valid username and password or PIN" });
            try
            {
                var result = await service.LoginAsync(
                    request,
                    AuthService.ClientIp(context),
                    context.Request.Headers.UserAgent.ToString(),
                    cancellationToken);
                context.Response.Cookies.Append("archive_mail_session", result.AccessToken, new CookieOptions
                {
                    HttpOnly = true,
                    SameSite = SameSiteMode.Strict,
                    Secure = context.Request.IsHttps,
                    Expires = DateTimeOffset.Parse(result.Session.ExpiresAt),
                    Path = "/"
                });
                return Results.Ok(result);
            }
            catch (AuthException exception)
            {
                return Results.Json(
                    new { error = exception.Message },
                    statusCode: exception.RateLimited
                        ? StatusCodes.Status429TooManyRequests
                        : StatusCodes.Status401Unauthorized);
            }
        }).WithName("Login").Produces<LoginResult>();

        auth.MapGet("/session", (HttpContext context) =>
        {
            var session = (SessionRecord)context.Items[AuthService.SessionItemKey]!;
            return Results.Ok(new SessionDto(session.Id, session.User, session.Role, session.ExpiresAt));
        }).WithName("CurrentSession").Produces<SessionDto>();

        auth.MapPost("/logout", async (
            HttpContext context,
            AuthService service,
            CancellationToken cancellationToken) =>
        {
            var session = (SessionRecord)context.Items[AuthService.SessionItemKey]!;
            await service.LogoutAsync(session.Id, cancellationToken);
            context.Response.Cookies.Delete("archive_mail_session", new CookieOptions { Path = "/" });
            return Results.NoContent();
        }).WithName("Logout").Produces(StatusCodes.Status204NoContent);

        auth.MapMethods("/pin", ["PATCH"], async (
            PinChangeRequest request,
            HttpContext context,
            AuthService service,
            CancellationToken cancellationToken) =>
        {
            var session = (SessionRecord)context.Items[AuthService.SessionItemKey]!;
            try
            {
                await service.ChangePinAsync(session, request.CurrentPin, request.NewPin, cancellationToken);
                context.Response.Cookies.Delete("archive_mail_session", new CookieOptions { Path = "/" });
                return Results.NoContent();
            }
            catch (Exception error) when (error is AuthException or ArgumentException)
            {
                return Results.BadRequest(new { error = error.Message });
            }
        }).WithName("ChangePin").Produces(StatusCodes.Status204NoContent);

        var users = app.MapGroup("/api/admin/users").WithTags("Users");
        users.MapGet("", async (HttpContext context, AuthService service, CancellationToken token) =>
            IsAdmin(context) ? Results.Ok(await service.ListUsersAsync(token)) : Results.Forbid())
            .WithName("ListUsers").Produces<IReadOnlyList<UserDto>>();

        users.MapPost("", async (UserCreateRequest request, HttpContext context, AuthService service, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            try { return Results.Json(await service.CreateUserAsync(request, token), statusCode: StatusCodes.Status201Created); }
            catch (Exception error) { return UserError(error); }
        }).WithName("CreateUser").Produces<UserDto>(StatusCodes.Status201Created);

        users.MapMethods("/{userId}", ["PATCH"], async (string userId, UserUpdateRequest request,
            HttpContext context, AuthService service, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            try { return Results.Ok(await service.UpdateUserAsync(userId, request, token)); }
            catch (Exception error) { return UserError(error); }
        }).WithName("UpdateUser").Produces<UserDto>();

        users.MapDelete("/{userId}",async(string userId,HttpContext context,AuthService service,CancellationToken token)=>
        {if(!IsAdmin(context))return Results.Forbid();try{var current=((SessionRecord)context.Items[AuthService.SessionItemKey]!).User.Id;await service.DeleteUserAsync(userId,current,token);return Results.NoContent();}catch(Exception error){return UserError(error);}}).WithName("DeleteUser");

        return app;
    }

    private static bool IsAdmin(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" };

    private static IResult UserError(Exception error) => error switch
    {
        AuthConflictException => Results.Conflict(new { error = error.Message }),
        AuthException => Results.NotFound(new { error = error.Message }),
        ArgumentException => Results.BadRequest(new { error = error.Message }),
        _ => throw error
    };
}
