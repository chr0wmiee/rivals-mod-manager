using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.UEFormat.Enums;

if (args.Length != 5)
{
    Console.Error.WriteLine("Usage: RivalsAnimExporter <paks> <loose-assets> <output> <usmap> <package-name-fragment>");
    return 64;
}

var paks = Path.GetFullPath(args[0]);
var looseAssets = Path.GetFullPath(args[1]);
var output = new DirectoryInfo(Path.GetFullPath(args[2]));
var usmap = Path.GetFullPath(args[3]);
var wanted = args[4].Replace('\\', '/');
output.Create();

var nativeDirectory = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "tools", "RivalsMeshExporter", "native"));
ZlibHelper.Initialize(Path.Combine(nativeDirectory, ZlibHelper.DllName));
OodleHelper.Initialize(Path.Combine(nativeDirectory, OodleHelper.OodleFileName));

var version = new VersionContainer(EGame.GAME_MarvelRivals);
var looseProvider = new DefaultFileProvider(looseAssets, SearchOption.AllDirectories, version, StringComparer.OrdinalIgnoreCase);
looseProvider.Initialize();
var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, version, StringComparer.OrdinalIgnoreCase)
{
    MappingsContainer = new FileUsmapTypeMappingsProvider(usmap),
    UseLazyPackageSerialization = false
};
provider.Initialize();
provider.PostMount();
provider.Files.AddFiles(looseProvider.Files);

var matches = looseProvider.Files.Values
    .Where(file => file.Path.Replace('\\', '/').Contains(wanted, StringComparison.OrdinalIgnoreCase))
    .ToArray();
if (matches.Length == 0)
{
    Console.Error.WriteLine($"No package matched: {wanted}");
    return 2;
}

var options = new ExporterOptions
{
    CompressionFormat = EFileCompressionFormat.None
};

var exported = 0;
foreach (var file in matches)
{
    if (!provider.TryLoadPackage(file, out var package)) continue;
    foreach (var animation in package.GetExports().OfType<UAnimSequence>())
    {
        var exporter = new Exporter(animation, options);
        if (!exporter.TryWriteToDir(output, out var label, out var savedFile) || string.IsNullOrWhiteSpace(savedFile)) continue;
        Console.WriteLine($"{animation.Name}|{savedFile}|{label}");
        exported++;
    }
}

return exported > 0 ? 0 : 3;
