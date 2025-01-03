import { getInput, info, warning } from "@actions/core";
import fetch from "node-fetch";
import semver from "semver";
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

  let gameVersion = getGameVersion(
    wantedGameVersion,
    gameVersions,
    versionAliases,
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

  const additionalMods = (
    await Promise.all(
      (<string[]>(
        JSON.parse(getInput("additional-sources", { required: true }))
      )).map(async (repo) => {
        const releases = await fetchJson<GithubRelease[]>(
          `https://api.github.com/repos/${repo}/releases`,
        );
        return releases
          .flatMap((n) => n.assets)
          .map((n) => {
            const assetSplit = n.name.split("-");
            const assetVersion = assetSplit[1];
            const assetGameVersion = getGameVersion(
              assetSplit[2].substring(2),
              gameVersions,
              versionAliases,
            );
            return <GithubMod>{
              name: assetSplit[0],
              version: assetVersion as string,
              gameVersion: assetGameVersion as string,
              download: n.browser_download_url as string,
            };
          })
          .sort(
            (a, b) =>
              -semver.compareBuild(a.gameVersion, b.gameVersion) ||
              -semver.compareBuild(a.version, b.version),
          );
      }),
    )
  ).flat(1);

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
        semver.satisfies(m.version, depVersion as string),
    );

    if (dependency != null) {
      const depDownload = dependency.downloads.find(
        (d) => d.type === "universal",
      )?.url;

      if (!depDownload) {
        warning(`No universal download found for mod '${depName}'`);
        continue;
      }

      info(`Downloading mod '${depName}' version '${dependency.version}'`);
      await downloadAndExtract(
        `https://beatmods.com${depDownload}`,
        extractPath,
      );
      continue;
    }

    info(
      `Mod '${depName}' version '${depVersion}' not found on Beatmods, searching Github.`,
    );

    const githubDependency = additionalMods.find(
      (n: GithubMod) =>
        semver.lte(n.gameVersion, gameVersion) &&
        (n.name === depName || n.name == depAliases[depName]) &&
        semver.satisfies(n.version, depVersion as string),
    );

    if (githubDependency != null) {
      info(
        `Downloading mod '${depName}' version '${githubDependency.version}' from GitHub`,
      );
      await downloadAndExtract(githubDependency.download, extractPath);
      continue;
    }

    warning(`Mod '${depName}' version '${depVersion}' not found.`);
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

function getGameVersion(
  wantedGameVersion: string,
  gameVersions: string[],
  versionAliases: VersionAliasCollection,
) {
  return gameVersions.find(
    (gv) =>
      gv === wantedGameVersion ||
      versionAliases[gv].some((va) => va === wantedGameVersion),
  );
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

interface GithubMod {
  name: string;
  version: string;
  gameVersion: string;
  download: string;
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
