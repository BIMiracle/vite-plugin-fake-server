import { generateMockServer } from "./build";
import { getResponse, sleep } from "./getResponse.mjs";
import type { FakeRoute } from "./node";
import { fakerSchemaServer, isFunction, loggerOutput } from "./node";
import { resolvePluginOptions } from "./resolvePluginOptions";
import type { ResolvePluginOptionsType } from "./resolvePluginOptions";
import type { VitePluginFakeServerOptions } from "./types";
import { getRequestData, traverseHtml, nodeIsElement } from "./utils";
import chokidar from "chokidar";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, relative } from "node:path";
import { URL } from "node:url";
import { pathToRegexp, match } from "path-to-regexp";
import type { Plugin, ResolvedConfig, Connect, HtmlTagDescriptor } from "vite";

const require = createRequire(import.meta.url);

let fakeData: FakeRoute[] = [];
export const vitePluginFakeServer = async (options: VitePluginFakeServerOptions = {}): Promise<Plugin> => {
	// transform
	let isIndexHTML = true;
	let mainPath = "";

	let config: ResolvedConfig;
	let isDevServer = false;

	const opts = resolvePluginOptions(options);

	return {
		name: "vite-plugin-fake-server",
		configResolved(resolvedConfig) {
			config = resolvedConfig;
			if (resolvedConfig.command === "serve") {
				isDevServer = true;
			}
		},
		async configureServer({ middlewares }) {
			if (!isDevServer || !opts.enableDev) {
				return;
			}

			fakeData = await getFakeData(opts);
			const middleware = await requestMiddleware(opts);
			middlewares.use(middleware);

			if (opts.include && opts.include.length && opts.watch) {
				const watchDir = join(process.cwd(), opts.include);
				const watcher = chokidar.watch(watchDir, {
					ignoreInitial: true,
				});

				watcher.on("change", async (file) => {
					opts.logger && loggerOutput(`fake file change`, file);
					fakeData = await getFakeData(opts);
				});
			}
		},

		async transform(sourceCode, id) {
			if (isDevServer || !opts.enableProd) {
				return {
					code: sourceCode,
				};
			}
			if (isIndexHTML) {
				// https://github.com/vitejs/vite/blob/main/packages/vite/src/node/server/middlewares/indexHtml.ts#L222
				await traverseHtml(sourceCode, id, (node) => {
					if (!nodeIsElement(node)) {
						return;
					}
					// script tags
					if (node.nodeName === "script") {
						let isModule = false;
						let scriptSrcPath = "";
						for (const p of node.attrs) {
							if (p.name === "src" && p.value) {
								scriptSrcPath = p.value;
							} else if (p.name === "type" && p.value && p.value === "module") {
								isModule = true;
							}
						}
						if (isModule && scriptSrcPath.length > 0) {
							mainPath = scriptSrcPath;
						}
					}
				});
				isIndexHTML = false;
			}

			if (mainPath.length > 0 && id.endsWith(mainPath)) {
				const include = opts.include;
				const relativePath = relative(dirname(id), config.root);
				const globPatterns = opts.extensions.map((ext) => join(relativePath, include, `/**/*.${ext}`));
				const ignoreFiles = opts.exclude.map((file) => "!" + join(relativePath, file));

				const fakeTemplate = `
				const modules = import.meta.glob(${JSON.stringify([...globPatterns, ...ignoreFiles], null, 2)}, { eager: true });
				const fakeModuleList = Object.keys(modules).reduce((list, key) => {
					const module = modules[key] ?? {};
					for (const moduleKey of Object.keys(module)) {
						const mod = modules[key][moduleKey] ?? [];
						const modList = Array.isArray(mod) ? [...mod] : [mod];
						return [...list, ...modList];
					}
				}, []);
				window.__FAKE__MODULE__LIST__ = fakeModuleList;
				`;

				return {
					code: fakeTemplate + "\n" + sourceCode,
				};
			}

			return {
				code: sourceCode,
			};
		},

		async transformIndexHtml(htmlString) {
			if (isDevServer || !opts.enableProd) {
				return htmlString;
			}

			const scriptTagOptions: Omit<HtmlTagDescriptor, "children"> = {
				tag: "script",
				attrs: { type: "module" },
				injectTo: "head",
			};
			const scriptTagList: HtmlTagDescriptor[] = [];

			// warning message in production environment
			scriptTagList.push({
				...scriptTagOptions,
				children: `console.warn("[vite-plugin-fake-server]: The plugin is applied in the production environment, check in https://github.com/condorheroblog/vite-plugin-fake-server#enableprod");\n`,
			});

			// add xhook
			const xhookPath = join(dirname(require.resolve("xhook")), "../dist/xhook.js");
			const xhookContent = readFileSync(xhookPath, "utf-8");
			scriptTagList.push({
				...scriptTagOptions,
				children: `${xhookContent}\n;window.__XHOOK__=xhook;\n`,
			});

			// add path-to-regexp
			const pathToRegexpPath = join(dirname(require.resolve("path-to-regexp")), "../dist.es2015/index.js");
			const pathToRegexpContent = readFileSync(pathToRegexpPath, "utf-8");
			scriptTagList.push({
				...scriptTagOptions,
				children: `${pathToRegexpContent}\n;window.__PATH_TO_REGEXP__={pathToRegexp, match};\n`,
			});

			scriptTagList.push({
				...scriptTagOptions,
				children: `const fakeModuleList = window.__FAKE__MODULE__LIST__;
				const { pathToRegexp, match } = window.__PATH_TO_REGEXP__;
				__XHOOK__.before(async function(req, callback) {
					${sleep.toString()}
					${getResponse.toString()}

					function headersToObject(headers) {
						const headersObject = {};
						for (const [name, value] of headers.entries()) {
							headersObject[name] = value;
						}
						return headersObject;
					}

					const responseResult = await getResponse({
						URL,
						req,
						fakeModuleList,
						pathToRegexp,
						match,
						basename: ${opts.basename.length ? opts.basename : '""'},
						defaultTimeout: ${opts.timeout},
						globalResponseHeaders: ${JSON.stringify(opts.headers, null, 2)}
					});
					if (responseResult) {
						const { response, statusCode, statusText, url, query, params, responseHeaders, hash } = responseResult ?? {};
						if (response && typeof response === "function") {
							const fakeResponse = await Promise.resolve(
								response({ url, body: req.body, query, params, headers: req.headers, hash })
							);
							if(req.isFetch){
								if (typeof fakeResponse === "string") {
									if (!responseHeaders.get("Content-Type")) {
										responseHeaders.set("Content-Type", "text/plain");
									}
									callback(new Response(
										fakeResponse,
										{
											statusText,
											status: statusCode,
											headers: headersToObject(responseHeaders),
										}
									));
								} else {
									if (!responseHeaders.get("Content-Type")) {
										responseHeaders.set("Content-Type", "application/json");
									}
									callback(new Response(
										JSON.stringify(fakeResponse, null, 2),
										{
											statusText,
											status: statusCode,
											headers: headersToObject(responseHeaders),
										}
									));
								}
							} else {
								if(!req.type || req.type.toLowerCase() === "text") {
									if (!responseHeaders.get("Content-Type")) {
										responseHeaders.set("Content-Type", "text/plain");
									}
									callback({
										statusText,
										status: statusCode,
										text: fakeResponse,
										data: fakeResponse,
										headers: headersToObject(responseHeaders),
									});
								} else if (req.type.toLowerCase() === "json") {
									if (!responseHeaders.get("Content-Type")) {
										responseHeaders.set("Content-Type", "application/json");
									}
									callback({
										statusText,
										status: statusCode,
										data: fakeResponse,
										headers: headersToObject(responseHeaders),
									});
								} else if (req.type.toLowerCase() === "document") {
									if (!responseHeaders.get("Content-Type")) {
										responseHeaders.set("Content-Type", "application/xml");
									}
									const parser = new DOMParser();
									const xmlDoc = parser.parseFromString(fakeResponse,"application/xml");
									callback({
										statusText,
										status: statusCode,
										xml: xmlDoc,
										data: xmlDoc,
										headers: headersToObject(responseHeaders),
									});
								} else {
									// https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/responseType
									// "arraybuffer" | "blob"
									callback({
										statusText,
										status: statusCode,
										data: fakeResponse,
										headers: headersToObject(responseHeaders),
									});
								}
							}
						}
						console.log("%c request invoke", "color: blue", req.url);
					} else {
						// next external URL
						callback();
					}
				});`,
			});

			return scriptTagList;
		},

		async closeBundle() {
			/**
			 * Build a independently deployable mock service
			 */
			if (!isDevServer && opts.build) {
				await generateMockServer(opts);
			}
		},
	};
};

export async function getFakeData(options: ResolvePluginOptionsType) {
	return await fakerSchemaServer({ ...options, include: [options.include] });
}

export async function requestMiddleware(options: ResolvePluginOptionsType) {
	const { logger, basename, timeout: defaultTimeout, headers: globalResponseHeaders } = options;
	const middleware: Connect.NextHandleFunction = async (req, res, next) => {
		const responseResult = await getResponse({
			URL,
			req,
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-expect-error
			fakeModuleList: options?.fakeData ?? fakeData,
			pathToRegexp,
			match,
			basename,
			defaultTimeout,
			globalResponseHeaders,
		});
		if (responseResult) {
			const { rawResponse, response, statusCode, statusText, url, query, params, responseHeaders, hash } =
				responseResult ?? {};
			if (isFunction(rawResponse)) {
				await Promise.resolve(rawResponse(req, res));
			} else if (isFunction(response)) {
				const body = await getRequestData(req);

				for (const key of responseHeaders.keys()) {
					res.setHeader(key, responseHeaders.get(key)!);
				}

				if (!res.getHeader("Content-Type")) {
					res.setHeader("Content-Type", "application/json");
				}

				res.statusCode = statusCode;
				if (statusText) {
					res.statusMessage = statusText;
				}
				const fakeResponse = await Promise.resolve(
					response({ url, body, query, params, headers: req.headers, hash }, req, res),
				);
				if (typeof fakeResponse === "string") {
					// XML
					res.end(fakeResponse);
				} else {
					res.end(JSON.stringify(fakeResponse, null, 2));
				}
			}

			logger && loggerOutput("request invoke", req.url!);
		} else {
			next();
		}
	};

	return middleware;
}
