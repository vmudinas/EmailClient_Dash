using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodoEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/todos").WithTags("To-dos");
        group.MapGet("", async (string? start, string? end, HttpContext context, TodoRepository repository, CancellationToken token) =>
        {
            var session = Writable(context); if (session is null) return Results.Forbid(); if (start is null || end is null) return Results.BadRequest(new { error = "start and end query parameters are required" });
            try { return Results.Ok(await repository.ListAsync(start, end, session.User.Id, token)); } catch (ArgumentException error) { return Results.BadRequest(new { error = error.Message }); }
        }).WithName("ListTodos").Produces<IReadOnlyList<TodoDto>>();
        group.MapPost("", async (TodoCreateRequest request, HttpContext context, TodoRepository repository, CancellationToken token) =>
        { var session = Writable(context); if (session is null) return Results.Forbid(); try { return Results.Json(await repository.CreateAsync(request, session.User.Id, token), statusCode: 201); } catch (ArgumentException error) { return Results.BadRequest(new { error = error.Message }); } })
            .WithName("CreateTodo").Produces<TodoDto>(201);
        group.MapMethods("/{todoId}", ["PATCH"], async (string todoId, TodoPatchRequest request, HttpContext context, TodoRepository repository, CancellationToken token) =>
        { var session = Writable(context); if (session is null) return Results.Forbid(); try { return Results.Ok(await repository.UpdateAsync(todoId, request, session.User.Id, token)); } catch (Exception error) { return Error(error); } }).WithName("UpdateTodo").Produces<TodoDto>();
        group.MapDelete("/{todoId}", async (string todoId, HttpContext context, TodoRepository repository, CancellationToken token) =>
        { var session = Writable(context); if (session is null) return Results.Forbid(); try { await repository.DeleteAsync(todoId, session.User.Id, token); return Results.NoContent(); } catch (Exception error) { return Error(error); } }).WithName("DeleteTodo");
        return app;
    }
    private static SessionRecord? Writable(HttpContext context) => context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" or "user" } session ? session : null;
    private static IResult Error(Exception error) => error switch { MailNotFoundException => Results.NotFound(new { error = error.Message }), ArgumentException => Results.BadRequest(new { error = error.Message }), _ => throw error };
}
