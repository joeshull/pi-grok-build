/**
 * Grok Build extension for Pi Coding Agent.
 *
 * Provides:
 * 1. LLM Provider — routes inference through Grok Build CLI
 * 2. Tools — Grok CLI diagnostics plus xAI Imagine tools when XAI_API_KEY is configured
 * 3. Command — /grok for CLI status, inspection, models, sessions, and more
 */

import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { classifyGrokFailure, createDiagnostics, formatGrokFailure } from "./diagnostics.ts";
import {
  getGrokVersion,
  killAllProcesses,
  parseGrokModelsOutput,
  runGrokCommand,
  runGrokInspect,
  runGrokMemory,
  runGrokModels,
  runGrokModelsAsync,
  runGrokSessions,
  runGrokShare,
  validateGrokAuth,
} from "./grok-runner.ts";
import {
  buildGrokProviderModels,
  fallbackGrokBuildModel,
  GROK_BUILD_PROVIDER_ID,
  GROK_DEFAULT_INTEGRATION_MODE,
} from "./model-metadata.ts";
import { streamViaGrok } from "./provider.ts";
import type { GrokRunResult } from "./types.ts";
import { getXaiApiKey, imagineImage, imagineVideo, pollVideoGeneration } from "./xai-api.ts";

// Kill all active Grok subprocesses on exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = GROK_BUILD_PROVIDER_ID;
const diagnostics = createDiagnostics("extension");

const EMPTY_SCHEMA = Type.Object({}, { additionalProperties: false });

const RUN_SCHEMA = Type.Object(
  {
    args: Type.Array(Type.String(), { description: "Arguments to pass to grok" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
    cwd: Type.Optional(Type.String({ description: "Working directory" })),
  },
  { additionalProperties: false },
);

const SESSION_SCHEMA = Type.Object(
  {
    action: Type.String({ description: "Action: list, restore, or share a session" }),
    sessionId: Type.Optional(Type.String({ description: "Session ID for restore/share" })),
  },
  { additionalProperties: false },
);

const IMAGINE_IMAGE_SCHEMA = Type.Object(
  {
    prompt: Type.String({ description: "Text prompt describing the image to generate" }),
    model: Type.Optional(
      Type.String({ description: "Model ID; defaults to grok-imagine-image-quality" }),
    ),
    n: Type.Optional(Type.Number({ description: "Number of images" })),
    aspect_ratio: Type.Optional(Type.String({ description: "Aspect ratio, e.g. 16:9 or 1:1" })),
    resolution: Type.Optional(Type.String({ description: "Resolution: 1k or 2k" })),
    response_format: Type.Optional(Type.String({ description: "url or b64_json" })),
  },
  { additionalProperties: false },
);

const IMAGINE_VIDEO_SCHEMA = Type.Object(
  {
    prompt: Type.String({ description: "Text prompt describing the video to generate" }),
    model: Type.Optional(Type.String({ description: "Model ID; defaults to grok-imagine-video" })),
    image: Type.Optional(
      Type.String({ description: "Optional image URL/base64 for image-to-video" }),
    ),
    duration: Type.Optional(Type.Number({ description: "Duration in seconds (1-15)" })),
    aspect_ratio: Type.Optional(Type.String({ description: "Aspect ratio, e.g. 16:9" })),
    resolution: Type.Optional(Type.String({ description: "Resolution: 480p or 720p" })),
    poll: Type.Optional(
      Type.Boolean({
        description: "Poll until completion; defaults true. Set false to return request_id.",
      }),
    ),
    pollIntervalMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
    pollTimeoutMs: Type.Optional(Type.Number({ description: "Polling timeout in milliseconds" })),
  },
  { additionalProperties: false },
);

const VIDEO_STATUS_SCHEMA = Type.Object(
  {
    request_id: Type.String({ description: "xAI video generation request_id" }),
  },
  { additionalProperties: false },
);

export interface GrokBuildOptions {
  commandName?: string;
  toolNamePrefix?: string;
}

export function createGrokBuildExtension(options: GrokBuildOptions = {}) {
  const commandName = options.commandName ?? "grok";
  const toolNamePrefix = options.toolNamePrefix ?? "";

  return {
    register(pi: ExtensionAPI): void {
      try {
        // Registration must not wait for the Grok CLI. Keep the provider available
        // immediately and use the explicit models command for live discovery.
        const modelSource = "fallback";
        const models = [fallbackGrokBuildModel()];

        pi.registerProvider(PROVIDER_ID, {
          baseUrl: "pi-grok-build",
          apiKey: "unused",
          api: "pi-grok-build",
          models,
          streamSimple: (model, context, streamOptions) => {
            return streamViaGrok(model, context, {
              ...streamOptions,
            });
          },
        });
        // Probe the CLI after registration without blocking Pi startup. Discovery is
        // diagnostic-only for this session; provider models are intentionally stable.
        setImmediate(() => {
          void runGrokModelsAsync({ detach: true })
            .then((result) => {
              if (!result.ok) {
                diagnostics.warn("background grok model probe failed", () => ({
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                }));
                return;
              }

              const cliModels = parseGrokModelsOutput(result.stdout);
              if (/not authenticated/i.test(result.stdout) || cliModels.length === 0) {
                diagnostics.warn("background grok model probe found no authenticated models");
                return;
              }

              diagnostics.debug("background grok model probe completed", () => ({
                modelCount: cliModels.length,
              }));
            })
            .catch((err: unknown) => {
              diagnostics.warn("background grok model probe threw", () => ({
                error: err instanceof Error ? err.message : String(err),
              }));
            });
        });

        // --- Commands ---
        pi.registerCommand(commandName, {
          description: `Grok Build CLI integration (0.1.216): /${commandName} status | inspect | models | sessions | memory | completions | logout | import | run <args>`,
          handler: async (args: string, ctx: ExtensionCommandContext) => {
            const trimmed = args.trim();
            const [action, ...rest] = trimmed.split(/\s+/);

            if (!action || action === "status") {
              const version = getGrokVersion();
              const isAuthed = validateGrokAuth();
              const status =
                version === "unknown"
                  ? "Grok CLI missing or unavailable on PATH"
                  : `Grok Build CLI v${version}`;
              ctx.ui.notify(
                `${status} | Auth: ${isAuthed ? "✅" : "❌"} | Provider: ${PROVIDER_ID} (${models.length} models)`,
                version === "unknown" ? "error" : "info",
              );
            } else if (action === "inspect") {
              const result = runGrokInspect({ cwd: ctx.cwd });
              if (result.ok) {
                ctx.ui.notify(result.stdout.slice(0, 2000), "info");
              } else {
                ctx.ui.notify(result.stderr.slice(0, 500), "error");
              }
            } else if (action === "models") {
              const result = runGrokModels({ cwd: ctx.cwd });
              if (result.ok) {
                const discovered = parseGrokModelsOutput(result.stdout);
                const list = discovered.map((m) => `${m.id} — ${m.name}`).join("\n");
                ctx.ui.notify(list || result.stdout.slice(0, 2000), "info");
              } else {
                ctx.ui.notify(result.stderr.slice(0, 500), "error");
              }
            } else if (action === "sessions") {
              const result = runGrokSessions({ cwd: ctx.cwd });
              if (result.ok) {
                ctx.ui.notify(result.stdout.slice(0, 2000), "info");
              } else {
                ctx.ui.notify(result.stderr.slice(0, 500), "error");
              }
            } else if (action === "memory") {
              const result = runGrokMemory({ cwd: ctx.cwd });
              if (result.ok) {
                ctx.ui.notify(result.stdout.slice(0, 2000), "info");
              } else {
                ctx.ui.notify(result.stderr.slice(0, 500), "error");
              }
            } else if (action === "completions" || action === "logout" || action === "import") {
              // New top-level commands in 0.1.216
              const cmdArgs = [action, ...rest];
              const result = runGrokCommand(cmdArgs, { cwd: ctx.cwd });
              if (result.ok) {
                ctx.ui.notify(result.stdout.slice(0, 2000), "info");
              } else {
                ctx.ui.notify(result.stderr.slice(0, 500), "error");
              }
            } else if (action === "run") {
              const runArgs = rest.length > 0 ? rest : ["--help"];
              const result = runGrokCommand(runArgs, { cwd: ctx.cwd });
              if (result.ok) {
                ctx.ui.notify(result.stdout.slice(0, 2000), "info");
              } else {
                ctx.ui.notify(result.stderr.slice(0, 500), "error");
              }
            } else {
              ctx.ui.notify(
                `Unknown /${commandName} action "${action}". Try: status, inspect, models, sessions, memory, completions, logout, import, run <args>`,
                "warning",
              );
            }
          },
        });

        // --- Tools ---

        const inspectTool: ToolDefinition<
          typeof EMPTY_SCHEMA,
          {
            version: string;
            authed: boolean;
            providerId: string;
            integrationMode: string;
            modelSource: string;
            models: Array<{ id: string; name: string }>;
            inspect: GrokRunResult;
          },
          unknown
        > = {
          name: `${toolNamePrefix}grok_inspect`,
          label: "Grok Inspect",
          description: "Show Grok Build CLI status: version, authentication, and available models.",
          parameters: EMPTY_SCHEMA,
          async execute() {
            const version = getGrokVersion();
            const authed = validateGrokAuth();
            const inspect = runGrokInspect();
            const details = {
              version,
              authed,
              providerId: PROVIDER_ID,
              integrationMode: GROK_DEFAULT_INTEGRATION_MODE,
              modelSource,
              models: models.map((m) => ({ id: m.id, name: m.name })),
              inspect,
            };
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(details, null, 2),
                },
              ],
              details,
            };
          },
        };

        const runTool: ToolDefinition<
          typeof RUN_SCHEMA,
          { ok: boolean; stdout: string; stderr: string; exitCode: number | null },
          unknown
        > = {
          name: `${toolNamePrefix}grok_run`,
          label: "Grok Run",
          description:
            'Run an arbitrary Grok CLI command with arguments. Example: grok_run with args ["models"] lists models.',
          parameters: RUN_SCHEMA,
          async execute(_toolCallId, params) {
            const cmdOpts: { cwd?: string; timeout?: number } = {};
            if (params.cwd !== undefined) cmdOpts.cwd = params.cwd;
            if (params.timeout !== undefined) cmdOpts.timeout = params.timeout;
            const result = runGrokCommand(params.args, cmdOpts);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: result.ok,
                      exitCode: result.exitCode,
                      stdout: result.stdout,
                      stderr: result.stderr,
                    },
                    null,
                    2,
                  ),
                },
              ],
              details: result,
            };
          },
        };

        const modelsTool: ToolDefinition<
          typeof EMPTY_SCHEMA,
          { models: Array<{ id: string; name: string }> },
          unknown
        > = {
          name: `${toolNamePrefix}grok_models`,
          label: "Grok Models",
          description: "List available Grok models from the CLI.",
          parameters: EMPTY_SCHEMA,
          async execute() {
            const result = runGrokModels();
            const discovered = result.ok ? parseGrokModelsOutput(result.stdout) : [];
            const providerModels = buildGrokProviderModels(discovered);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      models: discovered,
                      providerModels,
                      source: "grok models",
                      raw: result.stdout.slice(0, 5000),
                    },
                    null,
                    2,
                  ),
                },
              ],
              details: { models: discovered, providerModels, source: "grok models" },
            };
          },
        };

        const sessionsTool: ToolDefinition<typeof SESSION_SCHEMA, GrokRunResult, unknown> = {
          name: `${toolNamePrefix}grok_sessions`,
          label: "Grok Sessions",
          description:
            "List, restore, or share Grok sessions. Action: 'list', 'restore', or 'share'. Provide sessionId for restore/share.",
          parameters: SESSION_SCHEMA,
          async execute(_toolCallId, params) {
            const args = ["sessions"];
            if (params.action === "restore" && params.sessionId) {
              args.push("restore", params.sessionId);
            } else if (params.action === "share" && params.sessionId) {
              const shareResult = runGrokShare(params.sessionId);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        ok: shareResult.ok,
                        stdout: shareResult.stdout,
                        stderr: shareResult.stderr,
                      },
                      null,
                      2,
                    ),
                  },
                ],
                details: shareResult,
              };
            }
            const result = runGrokCommand(args);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: result.ok, stdout: result.stdout.slice(0, 5000), stderr: result.stderr },
                    null,
                    2,
                  ),
                },
              ],
              details: result,
            };
          },
        };

        const memoryTool: ToolDefinition<typeof EMPTY_SCHEMA, GrokRunResult, unknown> = {
          name: `${toolNamePrefix}grok_memory`,
          label: "Grok Memory",
          description: "Show Grok cross-session memory entries.",
          parameters: EMPTY_SCHEMA,
          async execute() {
            const result = runGrokMemory();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: result.ok, stdout: result.stdout.slice(0, 5000), stderr: result.stderr },
                    null,
                    2,
                  ),
                },
              ],
              details: result,
            };
          },
        };

        const imagineImageTool: ToolDefinition<
          typeof IMAGINE_IMAGE_SCHEMA,
          { images: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> },
          unknown
        > = {
          name: `${toolNamePrefix}grok_imagine_image`,
          label: "Grok Imagine Image",
          description: "Generate images from a text prompt using the xAI Imagine API.",
          parameters: IMAGINE_IMAGE_SCHEMA,
          async execute(_toolCallId, params) {
            const imageOptions: Parameters<typeof imagineImage>[0] = { prompt: params.prompt };
            if (params.model !== undefined) imageOptions.model = params.model;
            if (params.n !== undefined) imageOptions.n = params.n;
            if (params.aspect_ratio !== undefined) imageOptions.aspect_ratio = params.aspect_ratio;
            if (params.resolution !== undefined) imageOptions.resolution = params.resolution;
            if (params.response_format === "url" || params.response_format === "b64_json") {
              imageOptions.response_format = params.response_format;
            }
            const result = await imagineImage(imageOptions);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: result.ok, images: result.images, error: result.error },
                    null,
                    2,
                  ),
                },
              ],
              details: { images: result.images },
            };
          },
        };

        const imagineVideoTool: ToolDefinition<
          typeof IMAGINE_VIDEO_SCHEMA,
          { video?: { url?: string; duration?: number }; request_id?: string; status?: string },
          unknown
        > = {
          name: `${toolNamePrefix}grok_imagine_video`,
          label: "Grok Imagine Video",
          description: "Generate video from text or an image using the documented xAI Imagine API.",
          parameters: IMAGINE_VIDEO_SCHEMA,
          async execute(_toolCallId, params) {
            const result = await imagineVideo(params);
            const details: Record<string, unknown> = {};
            if (result.video !== undefined) details.video = result.video;
            if (result.request_id !== undefined) details.request_id = result.request_id;
            if (result.status !== undefined) details.status = result.status;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: result.ok,
                      status: result.status,
                      video: result.video,
                      request_id: result.request_id,
                      error: result.error,
                    },
                    null,
                    2,
                  ),
                },
              ],
              details,
            };
          },
        };

        const videoStatusTool: ToolDefinition<
          typeof VIDEO_STATUS_SCHEMA,
          { video?: { url?: string; duration?: number }; status?: string },
          unknown
        > = {
          name: `${toolNamePrefix}grok_imagine_video_status`,
          label: "Grok Imagine Video Status",
          description: "Poll an xAI Imagine video generation request by request_id.",
          parameters: VIDEO_STATUS_SCHEMA,
          async execute(_toolCallId, params) {
            const result = await pollVideoGeneration(params.request_id);
            const details: Record<string, unknown> = {};
            if (result.video !== undefined) details.video = result.video;
            if (result.status !== undefined) details.status = result.status;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: result.ok,
                      status: result.status,
                      video: result.video,
                      model: result.model,
                      error: result.error,
                    },
                    null,
                    2,
                  ),
                },
              ],
              details,
            };
          },
        };

        pi.registerTool(inspectTool);
        pi.registerTool(runTool);
        pi.registerTool(modelsTool);
        pi.registerTool(sessionsTool);
        pi.registerTool(memoryTool);
        if (getXaiApiKey()) {
          pi.registerTool(imagineImageTool);
          pi.registerTool(imagineVideoTool);
          pi.registerTool(videoStatusTool);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.error("failed to register extension", () => ({
          diagnostic: classifyGrokFailure({ message }),
        }));
        throw new Error(formatGrokFailure(classifyGrokFailure({ message })), { cause: err });
      }
    },
  };
}
