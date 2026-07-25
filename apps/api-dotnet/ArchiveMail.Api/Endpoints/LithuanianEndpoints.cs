using ArchiveMail.Api.Learning;
using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class LithuanianEndpoints
{
    public static IEndpointRouteBuilder MapLithuanianEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/lithuanian").WithTags("Lithuanian trainer");

        group.MapGet("/words", async (HttpContext context, LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            return Results.Ok(await repository.ListAsync(session.User.Id, token));
        }).WithName("ListLithuanianWords").Produces<IReadOnlyList<LithuanianWordDto>>();

        // The pass mark travels with the list so the screen never hardcodes a percentage an
        // administrator has since changed.
        group.MapGet("/practice", async (HttpContext context, LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            return Results.Ok(await repository.PracticeAsync(session.User.Id, token));
        }).WithName("GetLithuanianPractice").Produces<LithuanianPracticeDto>();

        // A finished game. The score was counted in the browser, so it is clamped on the way in
        // rather than taken at face value.
        group.MapPost("/games", async (LithuanianGameRequest request, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            return Results.Ok(await repository.SaveGameAsync(request, session.User.Id, token));
        }).WithName("SaveLithuanianGame").Produces<LithuanianGameResultDto>();

        group.MapPost("/words/{wordId}/hints", async (string wordId, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.RefreshHintsAsync(wordId, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithName("RefreshLithuanianHints").Produces<LithuanianWordDto>();

        // Suggests the Lithuanian for the English the learner has typed, before anything is saved.
        // An empty translation is a normal answer -- no key configured, or the model returned
        // something unusable -- and the form falls back to typing the Lithuanian by hand.
        group.MapPost("/translate", async (LithuanianTranslateRequest request, HttpContext context,
            LithuanianTranslationService translation, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            var kind = request.Kind == "phrase" ? "phrase" : "word";
            return Results.Ok(await translation.TranslateAsync(request.English ?? "", kind, token));
        }).WithName("TranslateLithuanian").Produces<LithuanianTranslation>();

        // Offers phrases built around the word being typed. Suggestions are an offer, so an empty
        // list is a normal answer rather than an error.
        group.MapPost("/phrases", async (LithuanianPhraseRequest request, HttpContext context,
            LithuanianPhraseService phrases, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            return Results.Ok(await phrases.SuggestAsync(request.English ?? "", token));
        }).WithName("SuggestLithuanianPhrases").Produces<LithuanianPhraseSuggestions>();

        group.MapPost("/words", async (LithuanianWordCreateRequest request, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try { return Results.Json(await repository.CreateWordAsync(request, session.User.Id, token), statusCode: StatusCodes.Status201Created); }
            catch (Exception error) { return Error(error); }
        }).WithName("CreateLithuanianWord").Produces<LithuanianWordDto>(StatusCodes.Status201Created);

        // The reference pronunciation, generated once when the word was added. A word added
        // before a key was configured has none until this is posted to.
        group.MapGet("/words/{wordId}/pronunciation", async (string wordId, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try
            {
                var (path, contentType) = await repository.PronunciationContentAsync(wordId, session.User.Id, token);
                return Results.File(path, contentType);
            }
            catch (Exception error) { return Error(error); }
        }).WithName("GetLithuanianPronunciation");

        group.MapPost("/words/{wordId}/pronunciation", async (string wordId, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.RefreshPronunciationAsync(wordId, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithName("RefreshLithuanianPronunciation").Produces<LithuanianWordDto>();

        group.MapDelete("/words/{wordId}", async (string wordId, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try { await repository.DeleteWordAsync(wordId, session.User.Id, token); return Results.NoContent(); }
            catch (Exception error) { return Error(error); }
        }).WithName("DeleteLithuanianWord").Produces(StatusCodes.Status204NoContent);

        // The body is the audio; the transcript the browser's speech recognition produced rides in
        // the query string like other upload metadata in this API. The score is computed here from
        // that transcript and the stored word.
        group.MapPost("/words/{wordId}/recordings", async (string wordId, string? transcript, long? durationMs,
            HttpContext context, LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try
            {
                var recording = await repository.SaveRecordingAsync(
                    wordId, transcript, context.Request.ContentType, durationMs ?? 0,
                    context.Request.Body, session.User.Id, token);
                return Results.Json(recording, statusCode: StatusCodes.Status201Created);
            }
            catch (Exception error) { return Error(error); }
        }).WithName("CreateLithuanianRecording").Produces<LithuanianRecordingDto>(StatusCodes.Status201Created);

        group.MapGet("/recordings/{recordingId}/content", async (string recordingId, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try
            {
                var (path, contentType) = await repository.RecordingContentAsync(recordingId, session.User.Id, token);
                return Results.File(path, contentType, enableRangeProcessing: true);
            }
            catch (Exception error) { return Error(error); }
        }).WithName("GetLithuanianRecording");

        group.MapDelete("/recordings/{recordingId}", async (string recordingId, HttpContext context,
            LithuanianRepository repository, CancellationToken token) =>
        {
            var session = Learner(context);
            if (session is null) return Results.Forbid();
            try { await repository.DeleteRecordingAsync(recordingId, session.User.Id, token); return Results.NoContent(); }
            catch (Exception error) { return Error(error); }
        }).WithName("DeleteLithuanianRecording").Produces(StatusCodes.Status204NoContent);

        return app;
    }

    // The trainer is Lucas's only screen; an administrator keeps access so the practice list can
    // be checked or cleaned up from their own account.
    private static SessionRecord? Learner(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" or "lucas" } session ? session : null;

    private static IResult Error(Exception error) => error switch
    {
        MailNotFoundException => Results.NotFound(new { error = error.Message }),
        ArgumentException => Results.BadRequest(new { error = error.Message }),
        _ => throw error
    };
}
