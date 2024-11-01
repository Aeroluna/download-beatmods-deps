import { getInput, info, warning } from "@actions/core";
import fetch from "node-fetch";
import { satisfies } from "semver";
import decompress from "decompress";
import fs from "fs-extra";
import { spawn } from "child_process";

export async function run() {
  const projectConfiguration = getInput("project-configuration", {
    required: true,
  });

  const projectInfo = await getProjectInfo(
    getInput("project-path", { required: true }),
    projectConfiguration,
  );

  const wantedGameVersion = getInput("game-version") || projectInfo.gameVersion;

  const gameVersions = await fetchJson<string[]>(
    "https://versions.beatmods.com/versions.json",
  );
  const versionAliases = await fetchJson<VersionAliasCollection>(
    "https://alias.beatmods.com/aliases.json",
  );

  const extractPath = getInput("path", { required: true });

  let gameVersion = gameVersions.find(
    (gv) =>
      gv === wantedGameVersion ||
      versionAliases[gv].some((va) => va === wantedGameVersion),
  );
  if (gameVersion == null) {
    const latestVersion = gameVersions[0];
    warning(
      `Game version '${wantedGameVersion}' doesn't exist; using mods from latest version '${latestVersion}'`,
    );
    gameVersion = latestVersion;
  }

  info(`Fetching mods for game version '${gameVersion}'`);
  const mods = await fetchJson<Mod[]>(
    `https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=${gameVersion}`,
  );

  const depAliases = JSON.parse(getInput("aliases", { required: true }));
  const additionalDependencies = JSON.parse(
    getInput("additional-dependencies", { required: true }),
  );

  let additionalProjectDependencies = {};
  const excludedNames: string[] = [];
  await Promise.all(
    (<string[]>(
      JSON.parse(getInput("additional-project-paths", { required: true }))
    )).map(async (n) => {
      const additionalProjectInfo = await getProjectInfo(
        n,
        projectConfiguration,
      );
      additionalProjectDependencies = {
        ...additionalProjectDependencies,
        ...additionalProjectInfo.dependencies,
      };
      excludedNames.push(additionalProjectInfo.pluginId);
    }),
  );

  const additionalSources: { [key: string]: string } = JSON.parse(
    getInput("additional-sources", { required: true }),
  );

  for (const [depName, depVersion] of Object.entries({
    ...additionalProjectDependencies,
    ...projectInfo.dependencies,
    ...additionalDependencies,
  })) {
    // is installed with other beat saber references
    if (depName == "BSIPA" || excludedNames.includes(depName)) {
      continue;
    }

    const dependency = mods.find(
      (m) =>
        (m.name === depName || m.name == depAliases[depName]) &&
        satisfies(m.version, depVersion as string),
    );

    if (dependency == null) {
      if (depName in additionalSources) {
        const releases = await fetchJson<GithubRelease[]>(
          `https://api.github.com/repos/${additionalSources[depName]}/releases`,
        );

        for (const asset of releases.flatMap((n) => n.assets)) {
          const assetSplit = asset.name.split("-");
          const version = assetSplit[1];
          if (
            !assetSplit[0].startsWith(depName) ||
            !satisfies(version, depVersion as string) ||
            assetSplit[2].substring(2) != gameVersion
          ) {
            continue;
          }

          info(`Downloading mod '${depName}' version '${version}'`);
          await downloadAndExtract(asset.browser_download_url, extractPath);
          break;
        }

        warning(
          `Mod '${depName}' version '${depVersion}' not found in ${additionalSources[depName]}.`,
        );
        continue;
      } else {
        warning(`Mod '${depName}' version '${depVersion}' not found.`);
        continue;
      }
    }

    const depDownload = dependency.downloads.find(
      (d) => d.type === "universal",
    )?.url;

    if (!depDownload) {
      warning(`No universal download found for mod '${depName}'`);
      continue;
    }

    info(`Downloading mod '${depName}' version '${dependency.version}'`);
    await downloadAndExtract(`https://beatmods.com${depDownload}`, extractPath);
  }

  fs.appendFileSync(
    process.env["GITHUB_ENV"]!,
    `BeatSaberDir=${extractPath}\nGameDirectory=${extractPath}\n`,
    "utf8",
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return (await response.json()) as T;
}

async function downloadAndExtract(url: string, extractPath: string) {
  const response = await fetch(url);

  if (response.status != 200) {
    throw new Error(
      `Unexpected response status ${response.status} ${response.statusText}`,
    );
  }

  await decompress(Buffer.from(await response.arrayBuffer()), extractPath, {
    // https://github.com/kevva/decompress/issues/46#issuecomment-428018719
    filter: (file) => !file.path.endsWith("/"),
  });
}

async function getProjectInfo(
  projectPath: string,
  configuration: string,
): Promise<ProjectInfo> {
  return new Promise<ProjectInfo>((resolve, reject) => {
    const proc = spawn("dotnet", [
      "build",
      projectPath,
      "-c",
      configuration,
      "-getProperty:GameVersion",
      "-getItem:DependsOn",
    ]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: string) => {
      stdout += data;
    });

    proc.stderr.on("data", (data: string) => {
      stderr += data;
    });

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout.trim()) as Output;
          resolve({
            pluginId: data["Properties"]["PluginId"]!,
            gameVersion: data["Properties"]["GameVersion"]!,
            dependencies: data["Items"]["DependsOn"].reduce(
              (
                obj: { [key: string]: string },
                d: { [key: string]: string },
              ) => {
                obj[d["Identity"]] = d["Version"];
                return obj;
              },
              {},
            ),
          });
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(stderr.trim()));
      }
    });
  });
}

type VersionAliasCollection = { [key: string]: string[] };

interface Mod {
  name: string;
  version: string;
  downloads: ModDownload[];
}

interface ModDownload {
  type: "universal" | "steam" | "oculus";
  url: string;
}

interface GithubRelease {
  assets: GithubReleaseDownload[];
}

interface GithubReleaseDownload {
  name: string;
  browser_download_url: string;
}

interface Output {
  Items: { [key: string]: { [key: string]: string }[] };
  Properties: { [key: string]: string };
}

interface ProjectInfo {
  pluginId: string;
  gameVersion: string;
  dependencies: { [key: string]: string };
}
