namespace ArchiveMail.Api.Security;

internal static class ApiRouteAuthorization
{
    internal const string RenterDenied = "Renter accounts can only access their property portal";
    internal const string LucasDenied = "This account can only access the Lithuanian trainer";
    internal const string ScreenDenied = "Access to this feature is disabled for your account. Ask an administrator to enable it.";
    public static string? DenialReason(SessionRecord session, string method, PathString requestPath)
    {
        var path = requestPath.Value ?? string.Empty;
        if (session.User.Role == "renter" && !RenterCanAccess(method, path)) return RenterDenied;
        if (session.User.Role == "lucas" && !LucasCanAccess(method, path)) return LucasDenied;
        if (session.Role is not ("user" or "renter")) return null;

        var screen = ScreenForPath(path);
        if (screen is null || session.User.AllowedScreens is null
            || session.User.AllowedScreens.Contains(screen, StringComparer.Ordinal)) return null;
        return ScreenDenied;
    }

    internal static string? ScreenForPath(string path)
    {
        if (Starts(path, "/api/properties") || Starts(path, "/api/property-")) return "properties";
        if (Starts(path, "/api/calendar/") || Starts(path, "/api/todos")
            || Starts(path, "/api/admin/calendar/accounts") || path.EndsWith("/calendar-events", StringComparison.Ordinal))
            return "calendar";
        if (Starts(path, "/api/drafts") || path.EndsWith("/send", StringComparison.Ordinal)
            || path.EndsWith("/send-as", StringComparison.Ordinal)) return "compose";
        if (Starts(path, "/api/ai/") || path.Contains("/ai/", StringComparison.Ordinal)
            || path.EndsWith("/ai", StringComparison.Ordinal) || Starts(path, "/api/admin/ai-schedules")) return "ai";
        if (Starts(path, "/api/uploads") || Starts(path, "/api/import-jobs")
            || Starts(path, "/api/admin/import") || Starts(path, "/api/gmail/oauth/")) return "import";
        if (Starts(path, "/api/admin/reply-styles") || Starts(path, "/api/admin/resumes")
            || Starts(path, "/api/admin/sender-filing") || Starts(path, "/api/admin/smart-mail-rules")
            || Starts(path, "/api/admin/inbox-tabs") || Starts(path, "/api/admin/mailbox-tasks")) return "settings";
        return null;
    }

    internal static bool LucasCanAccess(string method, string path) =>
        Starts(path, "/api/lithuanian/")
        // Browser failures on the learner's phone would otherwise queue in local storage forever
        // instead of reaching the administrator's diagnostics.
        || (method.Equals("POST", StringComparison.OrdinalIgnoreCase) && path == "/api/diagnostics/client")
        || SessionRoute(method, path);

    internal static bool RenterCanAccess(string method, string path)
    {
        var verb = method.ToUpperInvariant();
        if (verb == "GET" && path is "/api/property-platform/overview" or "/api/properties/overview") return true;
        if (verb == "POST" && path is "/api/property-service-requests" or "/api/property-payments") return true;
        if (SessionRoute(method, path)) return true;

        var segments = path.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments switch
        {
            ["api", "properties", _, "photo"] when verb == "GET" => true,
            ["api", "property-payments", _, "checkout" or "sync"] when verb == "POST" => true,
            ["api", "property-document-versions", _, "content"] when verb == "GET" => true,
            ["api", "property-documents", _, "acknowledge"] when verb == "POST" => true,
            ["api", "property-service-requests", _, "comments" or "attachments"] when verb == "POST" => true,
            ["api", "property-request-attachments", _, "content"] when verb == "GET" => true,
            _ => false
        };
    }

    // Every restricted role still needs to read its own session, sign out, and change its PIN.
    private static bool SessionRoute(string method, string path)
    {
        var verb = method.ToUpperInvariant();
        return (verb == "GET" && path == "/api/auth/session")
            || (verb == "POST" && path == "/api/auth/logout")
            || (verb == "PATCH" && path == "/api/auth/pin");
    }

    private static bool Starts(string path, string prefix) => path.StartsWith(prefix, StringComparison.Ordinal);
}
