import type * as ts from 'typescript/lib/tsserverlibrary';
import type * as embedded from '@volar/language-core';

export function getProgram(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	core: embedded.LanguageContext,
	ls: ts.LanguageService,
) {

	const proxy: Partial<ts.Program> = {
		getRootFileNames,
		emit,
		getSyntacticDiagnostics,
		getSemanticDiagnostics,
		getGlobalDiagnostics,
		// @ts-expect-error
		getBindAndCheckDiagnostics,
	};

	return new Proxy({}, {
		get: (target: any, property: keyof ts.Program) => {
			if (property in proxy) {
				return proxy[property];
			}
			const program = getProgram();
			if (property in program) {
				return program[property];
			}
			return target[property];
		},
		// #17
		// notice: https://github.com/vuejs/language-tools/issues/2403
		set: (target, property, newValue) => {
			const program = getProgram() as any;
			target[property] = program[property] = newValue;
			return true;
		},
	});

	function getProgram() {
		return ls.getProgram()!;
	}

	function getRootFileNames() {
		return getProgram().getRootFileNames().filter(fileName => core.typescript.languageServiceHost.fileExists?.(fileName));
	}

	// for vue-tsc --noEmit --watch
	function getBindAndCheckDiagnostics(sourceFile?: ts.SourceFile, cancellationToken?: ts.CancellationToken) {
		return getSourceFileDiagnosticsWorker(sourceFile, cancellationToken, 'getBindAndCheckDiagnostics' as 'getSemanticDiagnostics');
	}

	// for vue-tsc --noEmit
	function getSyntacticDiagnostics(sourceFile?: ts.SourceFile, cancellationToken?: ts.CancellationToken) {
		return getSourceFileDiagnosticsWorker(sourceFile, cancellationToken, 'getSyntacticDiagnostics');
	}
	function getSemanticDiagnostics(sourceFile?: ts.SourceFile, cancellationToken?: ts.CancellationToken) {
		return getSourceFileDiagnosticsWorker(sourceFile, cancellationToken, 'getSemanticDiagnostics');
	}

	function getSourceFileDiagnosticsWorker<T extends 'getSyntacticDiagnostics' | 'getSemanticDiagnostics'>(
		sourceFile: ts.SourceFile | undefined,
		cancellationToken: ts.CancellationToken | undefined,
		api: T,
	): ReturnType<ts.Program[T]> {

		if (sourceFile) {

			const [virtualFile, source] = core.virtualFiles.getVirtualFile(sourceFile.fileName);

			if (virtualFile && source) {

				if (!virtualFile.capabilities.diagnostic)
					return [] as any;

				const errors = transformDiagnostics(ls.getProgram()?.[api](sourceFile, cancellationToken) ?? []);

				return errors as any;
			}
		}

		return transformDiagnostics(getProgram()[api](sourceFile, cancellationToken) ?? []) as any;
	}

	function getGlobalDiagnostics(cancellationToken?: ts.CancellationToken): readonly ts.Diagnostic[] {
		return transformDiagnostics(getProgram().getGlobalDiagnostics(cancellationToken) ?? []);
	}
	function emit(targetSourceFile?: ts.SourceFile, _writeFile?: ts.WriteFileCallback, cancellationToken?: ts.CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: ts.CustomTransformers): ts.EmitResult {
		const scriptResult = getProgram().emit(targetSourceFile, (core.typescript.languageServiceHost.writeFile ?? ts.sys.writeFile), cancellationToken, emitOnlyDtsFiles, customTransformers);
		return {
			emitSkipped: scriptResult.emitSkipped,
			emittedFiles: scriptResult.emittedFiles,
			diagnostics: transformDiagnostics(scriptResult.diagnostics),
		};
	}

	// transform
	function transformDiagnostics<T extends ts.Diagnostic | ts.DiagnosticWithLocation | ts.DiagnosticRelatedInformation>(diagnostics: readonly T[]): T[] {
		const result: T[] = [];

		for (const diagnostic of diagnostics) {
			if (
				diagnostic.file !== undefined
				&& diagnostic.start !== undefined
				&& diagnostic.length !== undefined
			) {

				const [virtualFile, source] = core.virtualFiles.getVirtualFile(diagnostic.file.fileName);

				if (virtualFile && source) {

					if (core.typescript.languageServiceHost.fileExists?.(source.fileName) === false)
						continue;

					for (const [sourceFileName, map] of core.virtualFiles.getMaps(virtualFile)) {

						if (sourceFileName !== source.fileName)
							continue;

						for (const start of map.toSourceOffsets(diagnostic.start)) {

							if (!start[1].data.diagnostic)
								continue;

							for (const end of map.toSourceOffsets(diagnostic.start + diagnostic.length, true)) {

								if (!end[1].data.diagnostic)
									continue;

								onMapping(diagnostic, source.fileName, start[0], end[0], source.snapshot.getText(0, source.snapshot.getLength()));
								break;
							}
							break;
						}
					}
				}
				else {

					if (core.typescript.languageServiceHost.fileExists?.(diagnostic.file.fileName) === false)
						continue;

					onMapping(diagnostic, diagnostic.file.fileName, diagnostic.start, diagnostic.start + diagnostic.length, diagnostic.file.text);
				}
			}
			else if (diagnostic.file === undefined) {
				result.push(diagnostic);
			}
		}

		return result;

		function onMapping(diagnostic: T, fileName: string, start: number, end: number, docText: string | undefined) {

			let file = fileName === diagnostic.file?.fileName
				? diagnostic.file
				: undefined;
			if (!file) {

				if (docText === undefined) {
					const snapshot = core.typescript.languageServiceHost.getScriptSnapshot(fileName);
					if (snapshot) {
						docText = snapshot.getText(0, snapshot.getLength());
					}
				}
				else {
					let scriptTarget = ts.ScriptTarget.JSON;
					if (
						fileName.endsWith('.js')
						|| fileName.endsWith('.ts')
						|| fileName.endsWith('.jsx')
						|| fileName.endsWith('.tsx')
						|| fileName.endsWith('.mjs')
						|| fileName.endsWith('.mts')
						|| fileName.endsWith('.cjs')
						|| fileName.endsWith('.cts')
					) {
						scriptTarget = ts.ScriptTarget.Latest;
					}
					file = ts.createSourceFile(fileName, docText, scriptTarget);
				}
			}
			const newDiagnostic: T = {
				...diagnostic,
				file,
				start: start,
				length: end - start,
			};
			const relatedInformation = (diagnostic as ts.Diagnostic).relatedInformation;
			if (relatedInformation) {
				(newDiagnostic as ts.Diagnostic).relatedInformation = transformDiagnostics(relatedInformation);
			}

			result.push(newDiagnostic);
		}
	}
}
