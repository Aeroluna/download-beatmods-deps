import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import * as process from "process";
import * as path from "path";
import * as nf from "node-fetch";
import * as ac from "@actions/core";
import * as child_process from "child_process";
import fs from "fs-extra";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { when } from "jest-when";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fetch = jest.fn().mockImplementation((url) => {
  throw new Error(`Unexpected web request to ${url}`);
});
const childProcessSpawn = jest.fn();
const appendFileSync = jest.fn();
const readFileSync = jest.fn();
const writeFileSync = jest.fn();

jest.unstable_mockModule("node-fetch", () => ({
  ...nf,
  __esModule: true,
  default: fetch,
}));

jest.unstable_mockModule("@actions/core", () => ({
  ...ac,
  __esModule: true,
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

jest.unstable_mockModule("child_process", () => ({
  ...child_process,
  __esModule: true,
  spawn: childProcessSpawn,
}));

jest.mock("fs-extra", () => ({
  ...fs,
  appendFileSync: appendFileSync,
  readFileSync: readFileSync,
  writeFileSync: writeFileSync,
}));

const { run } = await import("../src/main.js");
const core = await import("@actions/core");

function setInput(name: string, value: string) {
  process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
}

function mockFetch(url: string, body: nf.BodyInit | undefined, status = 200) {
  when(fetch)
    .calledWith(url)
    .mockReturnValue(
      new nf.Response(body, {
        status: status,
        headers: new nf.Headers({
          "Content-Type": "application/json",
        }),
      }),
    );
}

function mockBeatModsResponse(response: nf.Response | undefined = undefined) {
  when(fetch)
    .calledWith(
      expect.stringMatching(new RegExp("https://beatmods.com/uploads/.*")),
    )
    .mockImplementation(
      () =>
        response ||
        new nf.Response(
          fs.createReadStream(path.join(__dirname, "files", "dummy.zip")),
          {
            status: 200,
            headers: new nf.Headers({
              "Content-Type": "application/octet-stream",
            }),
          },
        ),
    );
}

function mockProcess(
  path: string,
  args: string[] = expect.anything(),
  stdout: string | undefined = undefined,
  stderr: string | undefined = undefined,
  exitCode: number = 0,
) {
  const proc = <child_process.ChildProcessWithoutNullStreams>new EventEmitter();
  proc.stdout = <Readable>new EventEmitter();
  proc.stderr = <Readable>new EventEmitter();

  when(childProcessSpawn)
    .calledWith(path, args)
    .mockImplementation(() => {
      process.nextTick(() => {
        if (stdout) {
          proc.stdout.emit("data", stdout);
        }

        if (stderr) {
          proc.stderr.emit("data", stderr);
        }

        process.nextTick(() => {
          proc.emit("close", exitCode);
        });
      });

      return proc;
    });
}

function mockProject({
  gameVersion = "1.13.2",
  dependsOn = {
    BSIPA: "^4.1.3",
    "BS Utils": "^1.6.3",
    SongCore: "^3.0.2",
  },
}: { gameVersion?: string; dependsOn?: { [key: string]: string } } = {}) {
  mockProcess(
    "dotnet",
    expect.anything(),
    JSON.stringify({
      Properties: {
        GameVersion: gameVersion,
      },
      Items: {
        DependsOn: Object.entries(dependsOn).map(([key, value]) => ({
          Identity: key,
          Version: value,
        })),
      },
    }),
  );
}

describe("main", () => {
  const env = { ...process.env };

  beforeEach(() => {
    setInput("path", path.join(__dirname, "BeatSaberReferenceAssemblies"));
    setInput("access-token", "github_pat_whatever");
    setInput("project-path", path.join(__dirname, "Project", "Project.csproj"));
    setInput("project-configuration", "Release");
    setInput("aliases", "{}");
    setInput("additional-dependencies", "{}");

    mockBeatModsResponse();
    mockProject();

    mockFetch(
      "https://versions.beatmods.com/versions.json",
      JSON.stringify(["1.16.1", "1.13.2"]),
    );
    mockFetch(
      "https://alias.beatmods.com/aliases.json",
      JSON.stringify({ "1.13.2": ["1.13.3"], "1.16.1": ["1.16.2"] }),
    );
    mockFetch(
      "https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.13.2",
      fs.readFileSync(path.join(__dirname, "files", "mods_1.13.2.json")),
    );
    mockFetch(
      "https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.16.1",
      fs.readFileSync(path.join(__dirname, "files", "mods_1.16.1.json")),
    );
  });

  it("downloads all mods listed in manifest", async () => {
    await run();

    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.13.2",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/uploads/600a65978384cf2e7ec725a9/universal/BS Utils-1.7.0.zip",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/uploads/6015b97e0eef816aa6d0c18a/universal/SongCore-3.1.0.zip",
    );
  });

  it("uses the action's game-version if specified", async () => {
    setInput("game-version", "1.16.1");

    await run();

    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.16.1",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/uploads/60b15a4b2d008b3daa41e900/universal/BS Utils-1.10.0.zip",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/uploads/60cbfebfaf1e3d4577e0366e/universal/SongCore-3.5.0.zip",
    );
  });

  it("defaults to the latest version on BeatMods if the specified version doesn't exist", async () => {
    mockProject({ gameVersion: "1.15.3" });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "Game version '1.15.3' doesn't exist; using mods from latest version '1.16.1'",
    );
  });

  it("resolves game version version aliases", async () => {
    mockProject({ gameVersion: "1.13.3" });

    await run();

    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.13.2",
    );
  });

  it("logs when a mod doesn't have a universal download link", async () => {
    mockProject({ dependsOn: { Dummy: "^4.1.0" } });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "Mod 'Dummy' version '^4.1.0' not found.",
    );
  });

  it("logs when a mod doesn't have a universal download link", async () => {
    mockProject({ dependsOn: { DummyNoDownload: "^4.1.0" } });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "No universal download found for mod 'DummyNoDownload'",
    );
  });

  it("rejects if mod download response isn't successful", async () => {
    mockBeatModsResponse(
      new nf.Response(null, { status: 401, statusText: "Unauthorized" }),
    );

    await expect(run()).rejects.toThrow(
      "Unexpected response status 401 Unauthorized",
    );
  });

  it("rejects if project info can't be parsed", async () => {
    mockProcess("dotnet", expect.anything(), "blah");

    await expect(run()).rejects.toThrow(
      "Unexpected token b in JSON at position 0",
    );
  });

  it("rejects if project info can't be retrieved", async () => {
    mockProcess("dotnet", expect.anything(), undefined, "Uh oh!", 1);

    await expect(run()).rejects.toThrow("Uh oh!");
  });

  afterEach(() => {
    fs.rmSync(path.join(__dirname, "BeatSaberReferenceAssemblies"), {
      recursive: true,
      force: true,
    });

    jest.resetAllMocks();

    for (const key in process.env) {
      const val = env[key];

      if (val) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });
});
