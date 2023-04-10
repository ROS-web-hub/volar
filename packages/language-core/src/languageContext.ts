import { posix as path } from 'path';
import type * as ts from 'typescript/lib/tsserverlibrary';
import { createVirtualFiles, forEachEmbeddedFile } from './virtualFiles';
import { LanguageModule, LanguageServiceHost, FileKind } from './types';

export type LanguageContext = ReturnType<typeof createLanguageContext>;

export function createLanguageContext(
	host: LanguageServiceHost,
	languageModules: LanguageModule[],
) {

	for (const languageModule of languageModules.reverse()) {
		if (languageModule.proxyLanguageServiceHost) {
			const proxyApis = languageModule.proxyLanguageServiceHost(host);
			host = new Proxy(host, {
				get(target, key: keyof ts.LanguageServiceHost) {
					if (key in proxyApis) {
						return proxyApis[key];
					}
					return target[key];
				},
			});
		}
	}

	let lastProjectVersion: string | undefined;
	let tsProjectVersion = 0;

	const virtualFiles = createVirtualFiles(languageModules);
	const ts = host.getTypeScriptModule?.();
	const scriptSnapshots = new Map<string, [string, ts.IScriptSnapshot]>();
	const sourceTsFileVersions = new Map<string, string>();
	const sourceFileVersions = new Map<string, string>();
	const virtualFileVersions = new Map<string, { value: number, virtualFileSnapshot: ts.IScriptSnapshot, sourceFileSnapshot: ts.IScriptSnapshot; }>();
	const _tsHost: Partial<ts.LanguageServiceHost> = {
		fileExists: host.fileExists
			? fileName => {

				const ext = fileName.substring(fileName.lastIndexOf('.'));
				if (
					ext === '.js'
					|| ext === '.ts'
					|| ext === '.jsx'
					|| ext === '.tsx'
				) {

					/**
					 * If try to access a external .vue file that outside of the project,
					 * the file will not process by language service host,
					 * so virtual file will not be created.
					 * 
					 * We try to create virtual file here.
					 */

					const sourceFileName = fileName.substring(0, fileName.lastIndexOf('.'));

					if (!virtualFiles.hasSource(sourceFileName)) {
						const scriptSnapshot = host.getScriptSnapshot(sourceFileName);
						if (scriptSnapshot) {
							virtualFiles.updateSource(sourceFileName, scriptSnapshot, host.getScriptLanguageId?.(sourceFileName));
						}
					}
				}

				if (virtualFiles.hasVirtualFile(fileName)) {
					return true;
				}

				return !!host.fileExists?.(fileName);
			}
			: undefined,
		getProjectVersion: () => {
			return tsProjectVersion.toString();
		},
		getScriptFileNames,
		getScriptVersion,
		getScriptSnapshot,
		readDirectory: (_path, extensions, exclude, include, depth) => {
			const result = host.readDirectory?.(_path, extensions, exclude, include, depth) ?? [];
			for (const { fileName } of virtualFiles.allSources()) {
				const vuePath2 = path.join(_path, path.basename(fileName));
				if (path.relative(_path.toLowerCase(), fileName.toLowerCase()).startsWith('..')) {
					continue;
				}
				if (!depth && fileName.toLowerCase() === vuePath2.toLowerCase()) {
					result.push(vuePath2);
				}
				else if (depth) {
					result.push(vuePath2); // TODO: depth num
				}
			}
			return result;
		},
		getScriptKind(fileName) {

			if (ts) {
				if (virtualFiles.hasSource(fileName))
					return ts.ScriptKind.Deferred;

				switch (path.extname(fileName)) {
					case '.js': return ts.ScriptKind.JS;
					case '.jsx': return ts.ScriptKind.JSX;
					case '.ts': return ts.ScriptKind.TS;
					case '.tsx': return ts.ScriptKind.TSX;
					case '.json': return ts.ScriptKind.JSON;
					default: return ts.ScriptKind.Unknown;
				}
			}

			return 0;
		},
	};

	return {
		typescript: {
			languageServiceHost: new Proxy(_tsHost as ts.LanguageServiceHost, {
				get: (target, property: keyof ts.LanguageServiceHost) => {
					update();
					return target[property] || host[property];
				},
			}),
		},
		virtualFiles: new Proxy(virtualFiles, {
			get: (target, property) => {
				update();
				return target[property as keyof typeof virtualFiles];
			},
		}),
	};

	function update() {

		const newProjectVersion = host.getProjectVersion?.();
		const shouldUpdate = newProjectVersion === undefined || newProjectVersion !== lastProjectVersion;

		lastProjectVersion = newProjectVersion;

		if (!shouldUpdate)
			return;

		let shouldUpdateTsProject = false;
		let virtualFilesUpdatedNum = 0;

		const remainRootFiles = new Set(host.getScriptFileNames());

		// .vue
		for (const { fileName } of virtualFiles.allSources()) {
			remainRootFiles.delete(fileName);

			const snapshot = host.getScriptSnapshot(fileName);
			if (!snapshot) {
				// delete
				virtualFiles.deleteSource(fileName);
				shouldUpdateTsProject = true;
				virtualFilesUpdatedNum++;
				continue;
			}

			const newVersion = host.getScriptVersion(fileName);
			if (sourceFileVersions.get(fileName) !== newVersion) {
				// update
				sourceFileVersions.set(fileName, newVersion);
				virtualFiles.updateSource(fileName, snapshot, host.getScriptLanguageId?.(fileName));
				virtualFilesUpdatedNum++;
			}
		}

		// no any vue file version change, it mean project version was update by ts file change at this time
		if (!virtualFilesUpdatedNum) {
			shouldUpdateTsProject = true;
		}

		// add
		for (const fileName of [...remainRootFiles]) {
			const snapshot = host.getScriptSnapshot(fileName);
			if (snapshot) {
				const virtualFile = virtualFiles.updateSource(fileName, snapshot, host.getScriptLanguageId?.(fileName));
				if (virtualFile) {
					remainRootFiles.delete(fileName);
				}
			}
		}

		// .ts / .js / .d.ts / .json ...
		for (const [oldTsFileName, oldTsFileVersion] of [...sourceTsFileVersions]) {
			const newVersion = host.getScriptVersion(oldTsFileName);
			if (oldTsFileVersion !== newVersion) {
				if (!remainRootFiles.has(oldTsFileName) && !host.getScriptSnapshot(oldTsFileName)) {
					// delete
					sourceTsFileVersions.delete(oldTsFileName);
				}
				else {
					// update
					sourceTsFileVersions.set(oldTsFileName, newVersion);
				}
				shouldUpdateTsProject = true;
			}
		}

		for (const nowFileName of remainRootFiles) {
			if (!sourceTsFileVersions.has(nowFileName)) {
				// add
				const newVersion = host.getScriptVersion(nowFileName);
				sourceTsFileVersions.set(nowFileName, newVersion);
				shouldUpdateTsProject = true;
			}
		}

		for (const { root: rootVirtualFile } of virtualFiles.allSources()) {
			if (!shouldUpdateTsProject) {
				forEachEmbeddedFile(rootVirtualFile, embedded => {
					if (embedded.kind === FileKind.TypeScriptHostFile) {
						if (virtualFileVersions.has(embedded.fileName) && virtualFileVersions.get(embedded.fileName)?.virtualFileSnapshot !== embedded.snapshot) {
							shouldUpdateTsProject = true;
						}
					}
				});
			}
		}

		if (shouldUpdateTsProject) {
			tsProjectVersion++;
		}
	}
	function getScriptFileNames() {

		const tsFileNames = new Set<string>();

		for (const { root: rootVirtualFile } of virtualFiles.allSources()) {
			forEachEmbeddedFile(rootVirtualFile, embedded => {
				if (embedded.kind === FileKind.TypeScriptHostFile) {
					tsFileNames.add(embedded.fileName); // virtual .ts
				}
			});
		}

		for (const fileName of host.getScriptFileNames()) {
			if (!virtualFiles.hasSource(fileName)) {
				tsFileNames.add(fileName); // .ts
			}
		}

		return [...tsFileNames];
	}
	function getScriptVersion(fileName: string) {
		let [virtualFile, source] = virtualFiles.getVirtualFile(fileName);
		if (virtualFile && source) {
			let version = virtualFileVersions.get(virtualFile.fileName);
			if (!version) {
				version = {
					value: 0,
					virtualFileSnapshot: virtualFile.snapshot,
					sourceFileSnapshot: source.snapshot,
				};
				virtualFileVersions.set(virtualFile.fileName, version);
			}
			else if (
				version.virtualFileSnapshot !== virtualFile.snapshot
				|| (host.isTsc && version.sourceFileSnapshot !== source.snapshot) // fix https://github.com/johnsoncodehk/volar/issues/1082
			) {
				version.value++;
				version.virtualFileSnapshot = virtualFile.snapshot;
				version.sourceFileSnapshot = source.snapshot;
			}
			return version.value.toString();
		}
		return host.getScriptVersion(fileName);
	}
	function getScriptSnapshot(fileName: string) {
		const version = getScriptVersion(fileName);
		const cache = scriptSnapshots.get(fileName.toLowerCase());
		if (cache && cache[0] === version) {
			return cache[1];
		}
		const [virtualFile] = virtualFiles.getVirtualFile(fileName);
		if (virtualFile) {
			const snapshot = virtualFile.snapshot;
			scriptSnapshots.set(fileName.toLowerCase(), [version, snapshot]);
			return snapshot;
		}
		let tsScript = host.getScriptSnapshot(fileName);
		if (tsScript) {
			scriptSnapshots.set(fileName.toLowerCase(), [version, tsScript]);
			return tsScript;
		}
	}
}
