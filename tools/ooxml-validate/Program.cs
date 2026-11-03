// X-08: OpenXML SDK validation of exported workbooks. Exit 0 = no errors, 1 = errors, 2 = usage / unreadable file.
// Usage: dotnet run --project tools/ooxml-validate/OoxmlValidate.csproj -- <file.xlsx | folder> [...]
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

var files = new List<string>();
foreach (var arg in args)
{
    if (Directory.Exists(arg))
        files.AddRange(Directory.GetFiles(arg, "*.xlsx", SearchOption.AllDirectories));
    else if (File.Exists(arg))
        files.Add(arg);
    else
    {
        Console.Error.WriteLine($"not found: {arg}");
        return 2;
    }
}
files.Sort(StringComparer.Ordinal);
if (files.Count == 0)
{
    Console.Error.WriteLine("usage: OoxmlValidate <file.xlsx | folder> [...]");
    return 2;
}

var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365);
var total = 0;
foreach (var file in files)
{
    try
    {
        using var doc = SpreadsheetDocument.Open(file, false);
        var errors = validator.Validate(doc).ToList();
        total += errors.Count;
        Console.WriteLine($"{(errors.Count == 0 ? "ok  " : "FAIL")} {Path.GetFileName(file)} ({errors.Count} errors)");
        foreach (var e in errors.Take(50))
            Console.WriteLine($"     {e.Part?.Uri} {e.Path?.XPath}: {e.Description}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"FAIL {Path.GetFileName(file)}: cannot open ({ex.GetType().Name}: {ex.Message})");
        return 2;
    }
}
Console.WriteLine($"{files.Count} files, {total} errors");
return total == 0 ? 0 : 1;
