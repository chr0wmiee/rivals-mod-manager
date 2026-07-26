using System.Text.Json;
using CUE4Parse.Compression;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.Nanite;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Meshes;
using CUE4Parse_Conversion.Textures;
using CUE4Parse_Conversion.Textures.BC;
using CUE4Parse_Conversion.UEFormat.Enums;

internal static class Program
{
    private sealed record ExportedModel(string Name, string Type, string File);
    private sealed record FailedPackage(string Package, string Error);
    private sealed record ExportResult(List<ExportedModel> Models, List<FailedPackage> Errors, int PackagesInspected);

    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("Usage: RivalsMeshExporter <extracted-directory> <output-directory> <MarvelRivals.usmap> [game-paks-directory] [aes-key]");
            return 64;
        }

        var inputDirectory = Path.GetFullPath(args[0]);
        var outputDirectory = Path.GetFullPath(args[1]);
        var mappingsFile = Path.GetFullPath(args[2]);
        var gamePaksDirectory = args.Length >= 4 && !string.IsNullOrWhiteSpace(args[3]) ? Path.GetFullPath(args[3]) : null;
        var aesKey = args.Length >= 5 ? args[4].Replace("0x", "", StringComparison.OrdinalIgnoreCase) : string.Empty;
        if (!Directory.Exists(inputDirectory))
        {
            Console.Error.WriteLine($"Extracted asset directory does not exist: {inputDirectory}");
            return 66;
        }
        if (!File.Exists(mappingsFile))
        {
            Console.Error.WriteLine($"Marvel Rivals mappings file does not exist: {mappingsFile}");
            return 66;
        }

        Directory.CreateDirectory(outputDirectory);
        var version = new VersionContainer(EGame.GAME_MarvelRivals, ETexturePlatform.DesktopMobile);
        var looseProvider = new DefaultFileProvider(inputDirectory, SearchOption.AllDirectories, version, StringComparer.OrdinalIgnoreCase);
        looseProvider.Initialize();
        var candidates = looseProvider.Files.Values.Where(file =>
            file.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase) ||
            file.Path.EndsWith(".umap", StringComparison.OrdinalIgnoreCase)).ToArray();

        DefaultFileProvider provider;
        if (gamePaksDirectory is not null && Directory.Exists(gamePaksDirectory))
        {
            var nativeDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Rivals Mod Manager", "native");
            Directory.CreateDirectory(nativeDirectory);
            string NativePath(string name)
            {
                var bundled = Path.Combine(AppContext.BaseDirectory, "native", name);
                return File.Exists(bundled) ? bundled : Path.Combine(nativeDirectory, name);
            }
            ZlibHelper.Initialize(NativePath(ZlibHelper.DllName));
            OodleHelper.Initialize(NativePath(OodleHelper.OodleFileName));
            var detexPath = NativePath(DetexHelper.DLL_NAME);
            if (DetexHelper.LoadDll(detexPath)) DetexHelper.Initialize(detexPath);
            provider = new DefaultFileProvider(gamePaksDirectory, SearchOption.TopDirectoryOnly, version, StringComparer.OrdinalIgnoreCase)
            {
                MappingsContainer = new FileUsmapTypeMappingsProvider(mappingsFile),
                ReadNaniteData = true,
                SkipReferencedTextures = false,
                UseLazyPackageSerialization = false
            };
            provider.Initialize();
            if (aesKey.Length == 64) provider.SubmitKey(new FGuid(), new FAesKey(aesKey));
            provider.PostMount();
            provider.Files.AddFiles(looseProvider.Files);
        }
        else
        {
            provider = looseProvider;
        }

        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(mappingsFile);
        provider.ReadNaniteData = true;
        provider.SkipReferencedTextures = false;
        provider.UseLazyPackageSerialization = false;

        var options = new ExporterOptions
        {
            LodFormat = ELodFormat.FirstLod,
            MeshFormat = EMeshFormat.Gltf2,
            NaniteMeshFormat = ENaniteMeshFormat.OnlyNormalLODs,
            MaterialFormat = EMaterialFormat.AllLayersNoRef,
            TextureFormat = ETextureFormat.Png,
            CompressionFormat = EFileCompressionFormat.None,
            Platform = ETexturePlatform.DesktopMobile,
            SocketFormat = ESocketFormat.None,
            ExportMorphTargets = false,
            ExportMaterials = true,
            ExportHdrTexturesAsHdr = false
        };

        var exported = new List<ExportedModel>();
        var failures = new List<FailedPackage>();
        var inspected = 0;
        var output = new DirectoryInfo(outputDirectory);

        foreach (var file in candidates)
        {
            inspected++;
            try
            {
                if (!provider.TryLoadPackage(file, out var package)) continue;
                foreach (var export in package.GetExports())
                {
                    if (export is not UStaticMesh && export is not USkeletalMesh) continue;
                    var converter = new Exporter(export, options);
                    if (!converter.TryWriteToDir(output, out _, out var savedFile) || string.IsNullOrWhiteSpace(savedFile)) continue;
                    var fullPath = Path.GetFullPath(savedFile);
                    WaitForCompletedWrite(fullPath);
                    if (!File.Exists(fullPath)) continue;
                    exported.Add(new ExportedModel(
                        export.Name,
                        export is USkeletalMesh ? "SkeletalMesh" : "StaticMesh",
                        fullPath));
                }
            }
            catch (Exception error)
            {
                if (failures.Count < 40)
                {
                    var message = error.GetBaseException().Message.Split('\r', '\n')[0];
                    failures.Add(new FailedPackage(file.Path, message));
                }
            }
        }

        Console.WriteLine(JsonSerializer.Serialize(new ExportResult(exported, failures, inspected), new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }));
        return 0;
    }

    private static void WaitForCompletedWrite(string file)
    {
        long previousSize = -1;
        for (var attempt = 0; attempt < 100; attempt++)
        {
            try
            {
                if (File.Exists(file))
                {
                    var size = new FileInfo(file).Length;
                    using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None);
                    if (size > 0 && size == previousSize) return;
                    previousSize = size;
                }
            }
            catch (IOException) { }
            Thread.Sleep(25);
        }
    }
}
