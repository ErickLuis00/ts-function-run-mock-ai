// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import OpenAI from "openai";
/**
 * Interface representing a function parameter
 */
interface FunctionParameter {
	name: string;
	type: string | null;
	defaultValue: string | null;
	typeDetails?: ts.Type; // Store the actual TypeScript type for deeper analysis
	isOptional: boolean;   // Track if the parameter is optional
}

/**
 * Create TypeScript program and language service for type checking
 */
function createTsLanguageService(fileName: string): ts.LanguageService | null {
	try {
		const directory = path.dirname(fileName);

		// Find tsconfig.json in parent directories
		let configFile = ts.findConfigFile(directory, ts.sys.fileExists, 'tsconfig.json');

		if (!configFile) {
			// Use default settings if no tsconfig exists
			const defaultCompilerOptions: ts.CompilerOptions = {
				target: ts.ScriptTarget.ES2020,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.NodeJs,
				resolveJsonModule: true,
				esModuleInterop: true,
				strict: true,
				skipLibCheck: true
			};

			const host: ts.LanguageServiceHost = {
				getScriptFileNames: () => [fileName],
				getScriptVersion: () => '1',
				getScriptSnapshot: (name) => {
					if (!fs.existsSync(name)) { return undefined; }
					return ts.ScriptSnapshot.fromString(fs.readFileSync(name).toString());
				},
				getCurrentDirectory: () => directory,
				getCompilationSettings: () => defaultCompilerOptions,
				getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
				fileExists: ts.sys.fileExists,
				readFile: ts.sys.readFile,
				readDirectory: ts.sys.readDirectory,
			};

			return ts.createLanguageService(host);
		}

		// Read the tsconfig file
		const configJson = ts.readConfigFile(configFile, ts.sys.readFile);
		if (configJson.error) {
			console.error(`Error reading tsconfig: ${configJson.error.messageText}`);
			return null;
		}

		// Parse the tsconfig content
		const parsedConfig = ts.parseJsonConfigFileContent(
			configJson.config,
			ts.sys,
			path.dirname(configFile)
		);

		if (parsedConfig.errors.length) {
			console.error('Errors parsing tsconfig:', parsedConfig.errors);
			return null;
		}

		// Create the language service host
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => [fileName, ...parsedConfig.fileNames],
			getScriptVersion: () => '1',
			getScriptSnapshot: (name) => {
				if (!fs.existsSync(name)) { return undefined; }
				return ts.ScriptSnapshot.fromString(fs.readFileSync(name).toString());
			},
			getCurrentDirectory: () => directory,
			getCompilationSettings: () => parsedConfig.options,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
		};

		return ts.createLanguageService(host);
	} catch (error) {
		console.error('Error creating TypeScript language service:', error);
		return null;
	}
}

/**
 * Get function parameters using TypeScript language service
 */
function getParametersWithTypeInfo(
	filePath: string,
	position: number,
	funcName: string
): FunctionParameter[] {
	try {
		const langService = createTsLanguageService(filePath);

		if (!langService) {
			console.log('Failed to create language service, falling back to regex-based extraction');
			return [];
		}

		// Get the source file
		const program = langService.getProgram();
		if (!program) {
			console.log('Failed to get program from language service');
			return [];
		}

		const sourceFile = program.getSourceFile(filePath);
		if (!sourceFile) {
			console.log(`Could not find source file: ${filePath}`);
			return [];
		}

		// Find the function declaration node
		let functionNode: ts.FunctionDeclaration | ts.VariableDeclaration | null = null;

		const findNode = (node: ts.Node) => {
			if (ts.isFunctionDeclaration(node) && node.name?.text === funcName) {
				functionNode = node;
				return;
			}

			if (ts.isVariableDeclaration(node) &&
				node.name &&
				ts.isIdentifier(node.name) &&
				node.name.text === funcName &&
				node.initializer &&
				(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
				functionNode = node;
				return;
			}

			ts.forEachChild(node, findNode);
		};

		findNode(sourceFile);

		if (!functionNode) {
			console.log(`Could not find function node for: ${funcName}`);
			return [];
		}

		const typeChecker = program.getTypeChecker();
		const parameters: FunctionParameter[] = [];

		// Use type assertions to help TypeScript understand our types
		if (ts.isFunctionDeclaration(functionNode)) {
			const fnDeclaration = functionNode as ts.FunctionDeclaration;
			fnDeclaration.parameters.forEach((param: ts.ParameterDeclaration) => {
				const paramName = param.name.getText();
				const paramType = param.type ? param.type.getText() : null;
				const defaultValue = param.initializer ? param.initializer.getText() : null;

				// Check if parameter is optional - either has ? symbol or has default value
				const isOptional = param.questionToken !== undefined || param.initializer !== undefined;

				// Get detailed type information from type checker
				const symbol = typeChecker.getSymbolAtLocation(param.name);
				let detailedType = null;
				let actualType = null;

				if (symbol) {
					const type = typeChecker.getTypeOfSymbolAtLocation(symbol, param.name);
					detailedType = typeChecker.typeToString(type);
					actualType = type;
				} else if (param.type) {
					// Try to get the type directly from the type annotation
					const type = typeChecker.getTypeFromTypeNode(param.type);
					detailedType = typeChecker.typeToString(type);
					actualType = type;
				} else {
					detailedType = paramType;
				}

				parameters.push({
					name: paramName,
					type: detailedType,
					defaultValue: defaultValue,
					typeDetails: actualType || undefined,
					isOptional: isOptional
				});
			});
		} else if (ts.isVariableDeclaration(functionNode)) {
			const varDeclaration = functionNode as ts.VariableDeclaration;
			if (varDeclaration.initializer) {
				if (ts.isArrowFunction(varDeclaration.initializer) || ts.isFunctionExpression(varDeclaration.initializer)) {
					const arrowFn = varDeclaration.initializer as ts.ArrowFunction | ts.FunctionExpression;
					arrowFn.parameters.forEach((param: ts.ParameterDeclaration) => {
						const paramName = param.name.getText();
						const paramType = param.type ? param.type.getText() : null;
						const defaultValue = param.initializer ? param.initializer.getText() : null;

						// Check if parameter is optional
						const isOptional = param.questionToken !== undefined || param.initializer !== undefined;

						// Get detailed type information from type checker
						const symbol = typeChecker.getSymbolAtLocation(param.name);
						let detailedType = null;
						let actualType = null;

						if (symbol) {
							const type = typeChecker.getTypeOfSymbolAtLocation(symbol, param.name);
							detailedType = typeChecker.typeToString(type);
							actualType = type;
						} else if (param.type) {
							// Try to get the type directly from the type annotation
							const type = typeChecker.getTypeFromTypeNode(param.type);
							detailedType = typeChecker.typeToString(type);
							actualType = type;
						} else {
							detailedType = paramType;
						}

						parameters.push({
							name: paramName,
							type: detailedType,
							defaultValue: defaultValue,
							typeDetails: actualType || undefined,
							isOptional: isOptional
						});
					});
				}
			}
		}

		return parameters;
	} catch (error) {
		console.error('Error analyzing TypeScript:', error);
		return [];
	}
}

/**
 * Extract all type definitions from a TypeScript file
 */
function extractTypeDefinitions(
	sourceFile: ts.SourceFile,
	typeChecker: ts.TypeChecker,
	program: ts.Program,
	processedFiles: Set<string> = new Set()
): string[] {
	// Skip if we've already processed this file
	if (processedFiles.has(sourceFile.fileName)) {
		return [];
	}

	processedFiles.add(sourceFile.fileName);

	const typeDefinitions: string[] = [];
	const importedFileNames: string[] = [];

	function visit(node: ts.Node) {
		// Extract interfaces
		if (ts.isInterfaceDeclaration(node)) {
			typeDefinitions.push(node.getText());
		}
		// Extract type aliases
		else if (ts.isTypeAliasDeclaration(node)) {
			typeDefinitions.push(node.getText());
		}
		// Extract enum declarations
		else if (ts.isEnumDeclaration(node)) {
			typeDefinitions.push(node.getText());
		}
		// Extract class declarations (as they can be used as types)
		else if (ts.isClassDeclaration(node) && node.name) {
			typeDefinitions.push(node.getText());
		}
		// Track import declarations to follow them later
		else if (ts.isImportDeclaration(node)) {
			const importPath = node.moduleSpecifier.getText().replace(/['"]/g, '');
			if (!importPath.startsWith('.')) {
				// Skip node_modules imports as they're too large
				return;
			}

			try {
				// Try to resolve the import path
				const resolvedPath = ts.resolveModuleName(
					importPath,
					sourceFile.fileName,
					program.getCompilerOptions(),
					ts.sys
				);

				if (resolvedPath.resolvedModule) {
					importedFileNames.push(resolvedPath.resolvedModule.resolvedFileName);
				}
			} catch (error) {
				console.error(`Error resolving import ${importPath}:`, error);
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	// Process imported files recursively (to a reasonable depth)
	for (const importedFileName of importedFileNames) {
		const importedSourceFile = program.getSourceFile(importedFileName);
		if (importedSourceFile) {
			const importedTypes = extractTypeDefinitions(
				importedSourceFile,
				typeChecker,
				program,
				processedFiles
			);
			typeDefinitions.push(...importedTypes);
		}
	}

	return typeDefinitions;
}

/**
 * Get OpenAI API key from configuration or prompt user to enter it
 */
async function getOpenAIApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	// First check configuration
	const config = vscode.workspace.getConfiguration('function-run');
	let apiKey = config.get<string>('openaiApiKey');

	// If key exists in configuration, return it
	if (apiKey && apiKey.trim() !== '') {
		return apiKey;
	}

	// Check if we have it in secrets storage
	try {
		apiKey = await context.secrets.get('function-run.openai-api-key');
		if (apiKey && apiKey.trim() !== '') {
			return apiKey;
		}
	} catch (error) {
		console.error('Error accessing secrets storage:', error);
	}

	// If not found, prompt user
	apiKey = await vscode.window.showInputBox({
		prompt: 'Enter your OpenAI API key to enable function parameter generation',
		placeHolder: 'sk-...',
		password: true,
		ignoreFocusOut: true
	});

	// If user provided a key, store it securely
	if (apiKey && apiKey.trim() !== '') {
		try {
			await context.secrets.store('function-run.openai-api-key', apiKey);
			// Show confirmation message
			vscode.window.showInformationMessage('OpenAI API key has been stored securely. You can change it in settings.');
			return apiKey;
		} catch (error) {
			console.error('Error storing API key:', error);
			// Fallback to regular configuration if secrets API fails
			await config.update('openaiApiKey', apiKey, true);
			return apiKey;
		}
	}

	return undefined;
}

/**
 * Function to ask AI for a function call with appropriate mock values
 * @param paramTypesString String representation of parameter types
 * @param functionName Name of the function to call
 * @param fileContent The entire content of the file
 * @param typeDefinitions Type definitions to include in the AI call
 */
async function askAIForFunctionCall(
	paramTypesString: string,
	functionName: string,
	fileContent: string,
	typeDefinitions: string[] = [],
	context: vscode.ExtensionContext
): Promise<string> {
	try {
		// Log parameter types and file content size
		console.log(`Asking AI to generate call for ${functionName} with parameter types: ${paramTypesString}`);
		console.log(`Sending complete file content (${fileContent.length} characters) to AI for context`);

		if (typeDefinitions.length > 0) {
			console.log(`Including ${typeDefinitions.length} type definitions for context`);
		}

		// Get API key
		const apiKey = await getOpenAIApiKey(context);
		if (!apiKey) {
			return `(async () => { console.log(await ${functionName}(/* OpenAI API key not provided */)); })();`;
		}

		// Construct the message to send to the AI
		const aiPrompt = `
I need to generate a valid function call for the function '${functionName}' with these parameters:
${paramTypesString}

Here are all the type definitions that might be relevant:
${typeDefinitions.join('\n\n')}

Here is the full file content for context:
${fileContent}

Please generate only the code to call this function with valid parameters that match the required types. Inline values inside function call, do not generate variables. Optional fields are not necessary. You should generate multi line code if the function call has many parameters and values.

Put the function call in a (async () => { console.log(await <functionCall>); })(); block.`;

		console.log(aiPrompt);

		const openai = new OpenAI({
			apiKey: apiKey,
		});

		const response = await openai.chat.completions.create({
			model: "gpt-4.1",
			messages: [
				{
					"role": "system",
					"content": [
						{
							"type": "text",
							"text": aiPrompt
						}
					]
				}
			],
			response_format: {
				"type": "json_schema",
				"json_schema": {
					"name": "code_field",
					"strict": true,
					"schema": {
						"type": "object",
						"properties": {
							"code": {
								"type": "string",
								"description": "The generated code, multi line if the function call has many parameters and values."
							}
						},
						"required": [
							"code"
						],
						"additionalProperties": false
					}
				}
			},
			temperature: 1,
			max_completion_tokens: 10000,
			top_p: 1,
			frequency_penalty: 0,
			presence_penalty: 0,
			store: false
		});

		// Extract the code from the response
		const generatedCode = response.choices[0]?.message?.content;
		if (generatedCode) {
			try {
				const parsedResponse = JSON.parse(generatedCode);
				return parsedResponse.code;
			} catch (parseError) {
				console.error('Error parsing AI response:', parseError);
				return `(async () => { console.log(await ${functionName}(/* Error parsing AI response */)); })();`;
			}
		}

		return `(async () => { console.log(await ${functionName}(/* AI failed to generate params */)); })();`;
	} catch (error) {
		console.error('Error asking AI for function call:', error);
		return `(async () => { console.log(await ${functionName}()); })();`;
	}
}

/**
 * Check if Quokka extension is installed
 */
async function isQuokkaInstalled(): Promise<boolean> {
	const extensions = vscode.extensions.all;
	const quokkaInstalled = extensions.some(ext => ext.id.toLowerCase() === 'wallabyjs.quokka-vscode');
	console.log(`Quokka installed: ${quokkaInstalled}`);
	return quokkaInstalled;
}

/**
 * CodeLensProvider to show Run Function button above TypeScript functions
 */
export class CodelensProvider implements vscode.CodeLensProvider {
	private codeLenses: vscode.CodeLens[] = [];
	private regex: RegExp;
	private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
	// Track which functions are currently processing
	private processingFunctions: Set<string> = new Set();
	// Track which functions have been run in this session
	private executedFunctions: Set<string> = new Set();
	// Track if generated code is commented
	public commentedCode: Map<string, boolean> = new Map();

	constructor() {
		console.log('Initializing CodeLensProvider');
		// Regex to match functions - updated to better handle both JS and TS functions
		this.regex = /^\s*(export\s+)?(async\s+)?function\s+([a-zA-Z0-9_]+)/;

		vscode.workspace.onDidChangeConfiguration((_) => {
			console.log('Configuration changed, refreshing code lenses');
			this._onDidChangeCodeLenses.fire();
		});
	}

	// Method to track when a function is being processed
	public startProcessing(fileName: string, functionName: string): void {
		const key = `${fileName}|${functionName}`;
		this.processingFunctions.add(key);
		this._onDidChangeCodeLenses.fire(); // Update CodeLenses to show loading
	}

	// Method to track when processing is complete
	public endProcessing(fileName: string, functionName: string): void {
		const key = `${fileName}|${functionName}`;
		this.processingFunctions.delete(key);
		// Add to executed functions list
		this.executedFunctions.add(key);
		this._onDidChangeCodeLenses.fire(); // Update CodeLenses to show normal state
	}

	// Check if a function has generated code by searching for markers in the document
	public hasGeneratedCode(document: vscode.TextDocument, functionName: string): boolean {
		try {
			// Check for markers with the function name embedded directly in the marker
			const markerPattern = `// FUNCTION-RUN-GENERATED-CODE-START:${functionName}\\s*\\n[\\s\\S]*?// FUNCTION-RUN-GENERATED-CODE-END:${functionName}`;
			const markerRegex = new RegExp(markerPattern, 'g');
			const text = document.getText();

			const match = markerRegex.test(text);
			console.log(`hasGeneratedCode: Function '${functionName}' has exact marker? ${match}`);

			return match;
		} catch (error) {
			console.error(`Error checking for generated code for ${functionName}:`, error);
			return false;
		}
	}

	// Find and extract the marker range for a specific function
	public getFunctionMarkerRange(document: vscode.TextDocument, functionName: string): vscode.Range | null {
		try {
			const text = document.getText();
			const markerPattern = `// FUNCTION-RUN-GENERATED-CODE-START:${functionName}\\s*\\n[\\s\\S]*?// FUNCTION-RUN-GENERATED-CODE-END:${functionName}`;
			const markerRegex = new RegExp(markerPattern, 'g');

			let match = markerRegex.exec(text);
			if (match) {
				const startIndex = match.index;
				const endIndex = startIndex + match[0].length;
				const startPos = document.positionAt(startIndex);
				const endPos = document.positionAt(endIndex);
				return new vscode.Range(startPos, endPos);
			}

			return null; // No marker found for this function
		} catch (error) {
			console.error(`Error getting marker range for ${functionName}:`, error);
			return null;
		}
	}

	// Get all marker ranges in the document
	public getAllMarkerRanges(document: vscode.TextDocument): vscode.Range[] {
		try {
			const text = document.getText();
			// Match both new format and old format for backward compatibility
			const markerRegex = new RegExp(
				`// FUNCTION-RUN-GENERATED-CODE-START(?::([^\\s]*))?\\s*\\n([\\s\\S]*?)// FUNCTION-RUN-GENERATED-CODE-END(?::([^\\s]*))?`,
				'g'
			);

			const ranges: vscode.Range[] = [];
			let match;

			while ((match = markerRegex.exec(text)) !== null) {
				const startIndex = match.index;
				const endIndex = startIndex + match[0].length;
				const startPos = document.positionAt(startIndex);
				const endPos = document.positionAt(endIndex);
				ranges.push(new vscode.Range(startPos, endPos));
			}

			return ranges;
		} catch (error) {
			console.error('Error getting all marker ranges:', error);
			return [];
		}
	}

	// Extract function name from a marker
	public getFunctionNameFromMarker(document: vscode.TextDocument, range: vscode.Range): string | null {
		try {
			const markerText = document.getText(range);
			const match = markerText.match(/\/\/ FUNCTION-RUN-GENERATED-CODE-START:([a-zA-Z0-9_]+)/);
			return match ? match[1] : null;
		} catch (error) {
			console.error('Error extracting function name from marker:', error);
			return null;
		}
	}

	// Check if code is commented by examining the marker content
	public isCodeCommented(document: vscode.TextDocument, functionName: string): boolean {
		const markerRange = this.getFunctionMarkerRange(document, functionName);
		if (!markerRange) {
			return false;
		}

		const code = document.getText(markerRange);
		const lines = code.split('\n');

		// Skip the marker lines themselves and check the rest
		const contentLines = lines.filter(line =>
			!line.includes('FUNCTION-RUN-GENERATED-CODE-START:') &&
			!line.includes('FUNCTION-RUN-GENERATED-CODE-END:') &&
			line.trim() !== '');

		// If all remaining lines are commented or empty, the code is considered commented
		return contentLines.every(line => line.trimStart().startsWith('//'));
	}

	// Remove from executed functions list
	public removeFromExecuted(filePath: string, functionName: string): void {
		const key = `${filePath}|${functionName}`;
		this.executedFunctions.delete(key);
		this._onDidChangeCodeLenses.fire(); // Update CodeLenses
	}

	// Check if a function is currently processing
	public isProcessing(fileName: string, functionName: string): boolean {
		const key = `${fileName}|${functionName}`;
		return this.processingFunctions.has(key);
	}

	// Check if a function has been executed in this session
	public hasBeenExecuted(fileName: string, functionName: string): boolean {
		const key = `${fileName}|${functionName}`;
		return this.executedFunctions.has(key);
	}

	// Strict check if a function has been executed in this session (only if it has generated code)
	public hasActiveExecution(document: vscode.TextDocument, functionName: string): boolean {
		const key = `${document.fileName}|${functionName}`;
		const hasBeenExecuted = this.executedFunctions.has(key);
		const hasGenCode = this.hasGeneratedCode(document, functionName);
		console.log(`hasActiveExecution: ${functionName}, hasBeenExecuted=${hasBeenExecuted}, hasGenCode=${hasGenCode}`);
		console.log(`hasActiveExecution: executedFunctions size=${this.executedFunctions.size}`);
		if (hasBeenExecuted) {
			console.log(`hasActiveExecution: Function ${functionName} is in executedFunctions`);
		}
		return hasBeenExecuted && hasGenCode;
	}

	private isEnabled(): boolean {
		const enabled = vscode.workspace
			.getConfiguration("function-run")
			.get("enableCodeLens", true);
		console.log(`CodeLens enabled: ${enabled}`);
		return enabled;
	}

	public provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
		if (!this.isEnabled()) {
			return [];
		}

		if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact' &&
			document.languageId !== 'javascript' && document.languageId !== 'javascriptreact') {
			return [];
		}

		console.log(`Providing CodeLenses for document: ${document.fileName}`);
		this.codeLenses = [];

		// Search line by line
		for (let i = 0; i < document.lineCount; i++) {
			const line = document.lineAt(i);
			const text = line.text;

			// First try to match function declarations
			const fnMatch = text.match(this.regex);
			if (fnMatch) {
				const functionName = fnMatch[3];
				console.log(`Found function declaration: ${functionName} at line ${i + 1}`);

				// Get the position in the document
				const position = document.offsetAt(new vscode.Position(i, 0));

				// Extract function signature - check next lines if needed for multi-line params
				let functionSignature = text;
				let currentLine = i;

				// If the function declaration doesn't have a complete signature on this line
				// (no closing parenthesis), look ahead to find it
				if (!text.includes(')') && currentLine + 1 < document.lineCount) {
					let nextLine;
					do {
						currentLine++;
						nextLine = document.lineAt(currentLine).text;
						functionSignature += ' ' + nextLine.trim();
					} while (!nextLine.includes(')') && currentLine + 1 < document.lineCount);
				}

				const range = new vscode.Range(i, 0, i, text.length);

				// Check if this function is currently being processed
				const isProcessing = this.isProcessing(document.fileName, functionName);
				console.log(`Is function ${functionName} processing? ${isProcessing}`);

				// Check if this function already has generated code
				const hasCode = this.hasGeneratedCode(document, functionName);
				console.log(`Does function ${functionName} have generated code? ${hasCode}`);

				// Check if function has active execution
				const hasActiveExec = this.hasActiveExecution(document, functionName);
				console.log(`Does function ${functionName} have active execution? ${hasActiveExec}`);

				// Log the function's execution status
				const hasBeenExecuted = this.hasBeenExecuted(document.fileName, functionName);
				console.log(`Has function ${functionName} been executed? ${hasBeenExecuted}`);

				if (isProcessing) {
					// Show loading state when processing
					console.log(`Adding 'Running...' button for ${functionName}`);
					this.codeLenses.push(
						new vscode.CodeLens(range, {
							title: "$(sync~spin) Running...",
							tooltip: "Function is currently running with Quokka",
							command: "function-run.runFunction",
							arguments: [document.uri, functionName, i, position, false], // false = don't regenerate
						})
					);
				} else {
					// Always show Generate and Run button
					console.log(`Adding 'Generate Mock and Run' button for ${functionName}`);
					this.codeLenses.push(
						new vscode.CodeLens(range, {
							title: "$(sparkle) Generate Mock and Run",
							tooltip: "Generate parameters with AI and run with Quokka",
							command: "function-run.runFunction",
							arguments: [document.uri, functionName, i, position, true], // true = regenerate
						})
					);

					// Only show Run Function button if code has been generated
					if (hasCode) {
						console.log(`Adding 'Run Function' button for ${functionName}`);
						this.codeLenses.push(
							new vscode.CodeLens(range, {
								title: "$(play) Run Function",
								tooltip: "Run without regenerating parameters",
								command: "function-run.runFunction",
								arguments: [document.uri, functionName, i, position, false], // false = don't regenerate
							})
						);

						// Add Remove Function Call button if code has been generated
						console.log(`Adding 'Remove Function Call' button for ${functionName}`);
						this.codeLenses.push(
							new vscode.CodeLens(range, {
								title: "$(trash) Remove Function Call",
								tooltip: "Remove the generated function call",
								command: "function-run.removeGeneratedCode",
								arguments: [document.uri, functionName, i],
							})
						);

						// Add a Stop Run button if this function has been executed AND it has generated code
						if (hasActiveExec) {
							console.log(`Adding 'Stop Run' button for ${functionName}`);
							this.codeLenses.push(
								new vscode.CodeLens(range, {
									title: "$(debug-stop) Stop Run",
									tooltip: "Stops all Quokka sessions",
									command: "function-run.stopQuokka",
									arguments: [],
								})
							);
						}
					} else {
						console.log(`NOT adding extra buttons for ${functionName} because hasCode=${hasCode}`);
					}
				}
			}

			// Also look for arrow functions
			const arrowFnRegex = /^\s*(export\s+)?(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(async\s*)?\(?.*\)?\s*=>/;
			const arrowMatch = text.match(arrowFnRegex);
			if (arrowMatch) {
				const functionName = arrowMatch[3];
				console.log(`Found arrow function: ${functionName} at line ${i + 1}`);

				// Get the position in the document
				const position = document.offsetAt(new vscode.Position(i, 0));

				// Extract function signature - check next lines if needed for multi-line params
				let functionSignature = text;
				let currentLine = i;

				// If the function declaration doesn't have a complete signature on this line
				// (no closing parenthesis), look ahead to find it
				if (!text.includes(')') && currentLine + 1 < document.lineCount) {
					let nextLine;
					do {
						currentLine++;
						nextLine = document.lineAt(currentLine).text;
						functionSignature += ' ' + nextLine.trim();
					} while (!nextLine.includes(')') && currentLine + 1 < document.lineCount);
				}

				const range = new vscode.Range(i, 0, i, text.length);

				// Check if this function is currently being processed
				const isProcessing = this.isProcessing(document.fileName, functionName);
				console.log(`Is arrow function ${functionName} processing? ${isProcessing}`);

				// Check if this function already has generated code
				const hasCode = this.hasGeneratedCode(document, functionName);
				console.log(`Does arrow function ${functionName} have generated code? ${hasCode}`);

				// Check if function has active execution
				const hasActiveExec = this.hasActiveExecution(document, functionName);
				console.log(`Does arrow function ${functionName} have active execution? ${hasActiveExec}`);

				if (isProcessing) {
					// Show loading state when processing
					console.log(`Adding 'Running...' button for arrow function ${functionName}`);
					this.codeLenses.push(
						new vscode.CodeLens(range, {
							title: "$(sync~spin) Running...",
							tooltip: "Function is currently running with Quokka",
							command: "function-run.runFunction",
							arguments: [document.uri, functionName, i, position, false], // false = don't regenerate
						})
					);
				} else {
					// Always show Generate and Run button
					console.log(`Adding 'Generate and Run' button for arrow function ${functionName}`);
					this.codeLenses.push(
						new vscode.CodeLens(range, {
							title: "$(sparkle) Generate and Run",
							tooltip: "Generate parameters with AI and run with Quokka",
							command: "function-run.runFunction",
							arguments: [document.uri, functionName, i, position, true], // true = regenerate
						})
					);

					// Only show Run Function button if code has been generated
					if (hasCode) {
						console.log(`Adding 'Run Function' button for arrow function ${functionName}`);
						this.codeLenses.push(
							new vscode.CodeLens(range, {
								title: "$(play) Run Function",
								tooltip: "Run without regenerating parameters",
								command: "function-run.runFunction",
								arguments: [document.uri, functionName, i, position, false], // false = don't regenerate
							})
						);

						// Add Remove Function Call button if code has been generated
						console.log(`Adding 'Remove Function Call' button for arrow function ${functionName}`);
						this.codeLenses.push(
							new vscode.CodeLens(range, {
								title: "$(trash) Remove Function Call",
								tooltip: "Remove the generated function call",
								command: "function-run.removeGeneratedCode",
								arguments: [document.uri, functionName, i],
							})
						);

						// Add a Stop Run button if this function has been executed AND it has generated code
						if (hasActiveExec) {
							console.log(`Adding 'Stop Run' button for arrow function ${functionName}`);
							this.codeLenses.push(
								new vscode.CodeLens(range, {
									title: "$(debug-stop) Stop Run",
									tooltip: "Stops all Quokka sessions",
									command: "function-run.stopQuokka",
									arguments: [],
								})
							);
						}
					} else {
						console.log(`NOT adding extra buttons for arrow function ${functionName} because hasCode=${hasCode}`);
					}
				}
			}
		}

		console.log(`Total CodeLenses provided: ${this.codeLenses.length}`);
		return this.codeLenses;
	}

	public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken) {
		if (this.isEnabled()) {
			return codeLens;
		}
		return null;
	}

	async provideMockFunction(document: vscode.TextDocument, functionName: string, startLine: number, paramTypesString: string): Promise<string> {
		const result = await askAIForFunctionCall(
			paramTypesString,
			functionName,
			document.getText(),
			[], // Empty array for typeDefinitions
			vscode.extensions.getExtension('function-run')?.packageJSON.contributes.configuration[0].properties['function-run.openaiApiKey'].default // Pass context
		);

		return result;
	}

	// Mark code as commented or uncommented
	public markCodeAsCommented(fileName: string, functionName: string, isCommented: boolean): void {
		const key = `${fileName}|${functionName}`;
		this.commentedCode.set(key, isCommented);
	}
}

/**
 * Extract parameters from JavaScript functions using regex-based approach
 */
function getParametersFromJavaScript(
	filePath: string,
	position: number,
	funcName: string
): FunctionParameter[] {
	try {
		// Read the file content
		const fileContent = fs.readFileSync(filePath, 'utf8');
		const lines = fileContent.split('\n');

		// Find the function declaration - could be standard function, arrow function, or method
		let functionRegex = new RegExp(`function\\s+${funcName}\\s*\\(([^)]*)\\)`, 'g');
		let arrowFunctionRegex = new RegExp(`(?:const|let|var)\\s+${funcName}\\s*=\\s*(?:async\\s*)?\\(?([^)]*)\\)?\\s*=>`, 'g');
		let methodRegex = new RegExp(`${funcName}\\s*\\(([^)]*)\\)\\s*{`, 'g');

		let functionMatch = functionRegex.exec(fileContent);
		let arrowMatch = arrowFunctionRegex.exec(fileContent);
		let methodMatch = methodRegex.exec(fileContent);

		let paramsStr = '';

		// Use the first match we find
		if (functionMatch) {
			paramsStr = functionMatch[1];
		} else if (arrowMatch) {
			paramsStr = arrowMatch[1];
		} else if (methodMatch) {
			paramsStr = methodMatch[1];
		} else {
			console.log(`Could not find function declaration for ${funcName}`);
			return [];
		}

		// Parse parameters
		const params = paramsStr.split(',').map(param => param.trim());
		const parameters: FunctionParameter[] = [];

		for (const param of params) {
			if (!param) continue; // Skip empty params

			// Check for default values
			const [paramName, defaultValueStr] = param.split('=').map(p => p.trim());
			// Check for destructured params or rest params - for now just use them as-is
			const cleanParamName = paramName
				.replace(/^\.\.\./, '') // Handle rest parameters
				.replace(/^\{|\}$/g, ''); // Handle simple destructuring

			parameters.push({
				name: cleanParamName,
				type: null, // No type information available in plain JS
				defaultValue: defaultValueStr || null,
				isOptional: !!defaultValueStr || param.includes('=')
			});
		}

		return parameters;
	} catch (error) {
		console.error('Error extracting parameters from JavaScript:', error);
		return [];
	}
}

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {
	// Register a command to set or update the OpenAI API key
	const setApiKeyCommand = vscode.commands.registerCommand('function-run.setOpenAIApiKey', async () => {
		const apiKey = await vscode.window.showInputBox({
			prompt: 'Enter your OpenAI API key',
			placeHolder: 'sk-...',
			password: true,
			ignoreFocusOut: true
		});

		if (apiKey && apiKey.trim() !== '') {
			try {
				// Store in secrets storage if available
				await context.secrets.store('function-run.openai-api-key', apiKey);
				vscode.window.showInformationMessage('OpenAI API key has been stored securely.');
			} catch (error) {
				console.error('Error storing API key in secrets:', error);
				// Fallback to regular configuration
				const config = vscode.workspace.getConfiguration('function-run');
				await config.update('openaiApiKey', apiKey, true);
				vscode.window.showInformationMessage('OpenAI API key has been stored in configuration.');
			}
		}
	});

	context.subscriptions.push(setApiKeyCommand);

	// Check if Quokka is installed and warn if not
	if (!await isQuokkaInstalled()) {
		vscode.window.showWarningMessage('This extension requires Quokka.js. Please install it from the VS Code Marketplace.');
	}

	// Register CodeLens provider
	const codelensProvider = new CodelensProvider();

	const disposables = [
		vscode.languages.registerCodeLensProvider(
			[
				{ language: 'typescript' },
				{ language: 'typescriptreact' },
				{ language: 'javascript' },
				{ language: 'javascriptreact' }
			],
			codelensProvider
		),

		// Register command to remove generated function call
		vscode.commands.registerCommand('function-run.removeGeneratedCode', async (
			docUri: vscode.Uri,
			functionName: string,
			lineNumber: number
		) => {
			try {
				// Open the document
				const document = await vscode.workspace.openTextDocument(docUri);
				const editor = await vscode.window.showTextDocument(document);

				// Find the specific marker associated with this function
				const markerRange = codelensProvider.getFunctionMarkerRange(document, functionName);
				let removedCode = false;

				const edit = new vscode.WorkspaceEdit();

				if (markerRange) {
					// Found specific marker for this function
					edit.delete(document.uri, markerRange);
					removedCode = true;
				} else {
					// For backward compatibility, try looking for old-style markers
					const fullText = document.getText();
					const markerRegex = new RegExp(
						`// FUNCTION-RUN-GENERATED-CODE-START(?::([^\\s]*))?\\s*\\n([\\s\\S]*?)// FUNCTION-RUN-GENERATED-CODE-END(?::([^\\s]*))?`,
						'g'
					);

					let match;
					while ((match = markerRegex.exec(fullText)) !== null) {
						// Check if this marker section contains a call to our function
						const markerContent = match[0];
						const escapedFunctionName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
						const functionCallRegex = new RegExp(`\\b${escapedFunctionName}\\(`, 'g');

						if (functionCallRegex.test(markerContent)) {
							// This marker is related to our function
							const startIndex = match.index;
							const endIndex = startIndex + match[0].length;
							const startPos = document.positionAt(startIndex);
							const endPos = document.positionAt(endIndex);
							const range = new vscode.Range(startPos, endPos);

							edit.delete(document.uri, range);
							removedCode = true;
							break;
						}
					}
				}

				if (!removedCode) {
					vscode.window.showInformationMessage(`No generated code found for ${functionName}`);
					return;
				}

				// Apply the edits
				await vscode.workspace.applyEdit(edit);

				// Remove from executed functions list to update UI
				codelensProvider.removeFromExecuted(docUri.fsPath, functionName);

				// Save the document
				await document.save();

				vscode.window.showInformationMessage(`Removed generated code for ${functionName}`);

				// Also stop all Quokka sessions, same as the Stop Run button
				await vscode.commands.executeCommand('function-run.stopQuokka');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error('Error removing generated code:', error);
				vscode.window.showErrorMessage(`Error removing generated code: ${errorMessage}`);
			}
		}),

		// Register the command to stop Quokka and comment generated code
		vscode.commands.registerCommand('function-run.stopQuokka', async () => {
			try {
				// Stop all Quokka sessions first
				await vscode.commands.executeCommand('quokka.stopAll');

				// Get the active editor
				const editor = vscode.window.activeTextEditor;
				if (editor) {
					const document = editor.document;

					// Find all marker blocks in the document
					const markerRanges = codelensProvider.getAllMarkerRanges(document);

					// Comment out generated code blocks that we found with markers
					let edits: vscode.TextEdit[] = [];

					for (const range of markerRanges) {
						const code = document.getText(range);

						// Skip if already fully commented
						if (code.split('\n').every(line =>
							line.trim() === '' ||
							line.trimStart().startsWith('//') ||
							line.includes('FUNCTION-RUN-GENERATED-CODE-START:') ||
							line.includes('FUNCTION-RUN-GENERATED-CODE-END:')
						)) {
							continue;
						}

						// Extract the function name from the marker if available
						const functionName = codelensProvider.getFunctionNameFromMarker(document, range);

						// Comment each line but preserve the special markers
						const lines = code.split('\n');
						const commentedLines = lines.map((line, index) => {
							// Don't comment the marker lines or already commented lines
							if (line.includes('FUNCTION-RUN-GENERATED-CODE-START:') ||
								line.includes('FUNCTION-RUN-GENERATED-CODE-END:') ||
								line.trimStart().startsWith('//') ||
								line.trim() === '') {
								return line;
							}
							return line.replace(/^(\s*)/, '$1// ');
						});

						// Create a TextEdit to replace the code with commented code
						edits.push(vscode.TextEdit.replace(range, commentedLines.join('\n')));

						// If we have a function name, mark it as commented and remove from executed functions
						if (functionName) {
							codelensProvider.markCodeAsCommented(document.fileName, functionName, true);
							codelensProvider.removeFromExecuted(document.fileName, functionName);
						}
					}

					// Apply the edits
					if (edits.length > 0) {
						const edit = new vscode.WorkspaceEdit();
						edit.set(document.uri, edits);
						await vscode.workspace.applyEdit(edit);

						// Save the document
						await document.save();

						vscode.window.showInformationMessage(`Commented out ${edits.length} generated code blocks`);
					}

					// Fold all the marker sections
					if (markerRanges.length > 0) {
						await editor.edit(() => { });  // Ensure document is ready for folding
						editor.selections = []; // Clear selections to avoid interfering with folding

						// Fold each range
						for (const range of markerRanges) {
							await vscode.commands.executeCommand('editor.fold', {
								selectionLines: [range.start.line]
							});
						}
					}
				}

				vscode.window.showInformationMessage('Stopped all Quokka sessions');
			} catch (error) {
				console.error('Error stopping Quokka:', error);
				vscode.window.showErrorMessage('Failed to stop Quokka sessions');
			}
		}),

		vscode.commands.registerCommand('function-run.runFunction', async (
			docUri: vscode.Uri,
			functionName: string,
			lineNumber: number,
			position: number,
			regenerate: boolean
		) => {
			try {
				// Check if this function is already being processed
				if (codelensProvider.isProcessing(docUri.fsPath, functionName)) {
					vscode.window.showInformationMessage(`Already running ${functionName}, please wait...`);
					return;
				}

				// Mark the function as being processed
				codelensProvider.startProcessing(docUri.fsPath, functionName);

				// Check again if Quokka is installed
				if (!await isQuokkaInstalled()) {
					const installOption = 'Install Quokka';
					const result = await vscode.window.showErrorMessage(
						'Quokka.js extension is required to run functions.',
						installOption
					);

					if (result === installOption) {
						await vscode.commands.executeCommand(
							'workbench.extensions.search',
							'wallabyjs.quokka-vscode'
						);
					}
					codelensProvider.endProcessing(docUri.fsPath, functionName);
					return;
				}

				// Open the document first
				const document = await vscode.workspace.openTextDocument(docUri);
				const editor = await vscode.window.showTextDocument(document);

				// Unfold any folded generated code sections
				const text = document.getText();
				const markerRegex = /\/\/ FUNCTION-RUN-GENERATED-CODE-START(?::([^\s]*))?\s*\n([\s\S]*?)\/\/ FUNCTION-RUN-GENERATED-CODE-END(?::([^\s]*))?/g;
				const foldingRanges: vscode.Range[] = [];

				let match;
				while ((match = markerRegex.exec(text)) !== null) {
					const startIndex = match.index;
					const endIndex = startIndex + match[0].length;
					const startPos = document.positionAt(startIndex);
					const endPos = document.positionAt(endIndex);

					foldingRanges.push(new vscode.Range(startPos, endPos));
				}

				// Unfold all the marker sections
				if (foldingRanges.length > 0) {
					await editor.edit(() => { });  // Ensure document is ready for unfolding
					editor.selections = []; // Clear selections to avoid interfering with unfolding

					// Unfold each range
					for (const range of foldingRanges) {
						await vscode.commands.executeCommand('editor.unfold', {
							selectionLines: [range.start.line]
						});
					}
				}

				try {
					// Check if there's already commented code that we can uncomment
					const markerRange = codelensProvider.getFunctionMarkerRange(document, functionName);
					const hasMarkers = markerRange !== null;

					// If run without regeneration and we have markers, check if the code is commented
					if (!regenerate && hasMarkers) {
						const hasCommentedCode = codelensProvider.isCodeCommented(document, functionName);

						// Uncomment the code if needed
						if (hasCommentedCode) {
							const edits: vscode.TextEdit[] = [];

							// Get the code within the markers
							const code = document.getText(markerRange!);
							const lines = code.split('\n');

							// Uncomment each line but leave the markers alone
							const uncommentedLines = lines.map(line => {
								// Don't touch the marker lines or already uncommented lines
								if (line.includes('FUNCTION-RUN-GENERATED-CODE-START:') ||
									line.includes('FUNCTION-RUN-GENERATED-CODE-END:') ||
									!line.trimStart().startsWith('//') ||
									line.trim() === '') {
									return line;
								}
								return line.replace(/^(\s*)\/\/ /, '$1');
							});

							edits.push(vscode.TextEdit.replace(markerRange!, uncommentedLines.join('\n')));

							// Apply edits
							if (edits.length > 0) {
								const edit = new vscode.WorkspaceEdit();
								edit.set(document.uri, edits);
								await vscode.workspace.applyEdit(edit);

								// Save the document
								await document.save();

								// Mark as uncommented
								codelensProvider.markCodeAsCommented(document.fileName, functionName, false);

								vscode.window.showInformationMessage(`Uncommented code for ${functionName}`);
							}

							// Make sure the function is marked as executed so the Stop button appears
							codelensProvider.endProcessing(docUri.fsPath, functionName);

							// Execute Quokka command to run the file
							await vscode.commands.executeCommand('quokka.makeQuokkaFromExistingFile');
							return;
						}
					}

					// If regenerate is true, generate a new function call
					if (regenerate) {
						// Extract parameters based on file type
						let params: FunctionParameter[] = [];

						if (document.languageId === 'javascript' || document.languageId === 'javascriptreact') {
							// Use JavaScript parameter extraction for JS files
							params = getParametersFromJavaScript(
								document.fileName,
								position,
								functionName
							);
						} else {
							// Use TypeScript parameter extraction for TS files
							params = getParametersWithTypeInfo(
								document.fileName,
								position,
								functionName
							);
						}

						// Create a more detailed type string for the AI
						let fullTypeInfoString = "";

						try {
							if (document.languageId === 'javascript' || document.languageId === 'javascriptreact') {
								// For JavaScript, just use parameter names since we don't have type info
								fullTypeInfoString = params
									.filter(param => !param.isOptional)
									.map(param => param.name)
									.join(', ');
							} else {
								// For TypeScript, use the full type information
								const langService = createTsLanguageService(document.fileName);
								if (langService && langService.getProgram()) {
									const program = langService.getProgram();
									if (program) {
										const typeChecker = program.getTypeChecker();

										// Build detailed type information for parameters
										const typeDefinitions = params
											.filter(param => !param.isOptional)
											.map(param => {
												// Use the full type if available
												if (param.typeDetails) {
													try {
														// Get full serializable representation of the type
														const fullType = typeChecker.typeToString(
															param.typeDetails,
															undefined,
															ts.TypeFormatFlags.NoTruncation |
															ts.TypeFormatFlags.WriteClassExpressionAsTypeLiteral |
															ts.TypeFormatFlags.UseFullyQualifiedType
														);
														return `${param.name}: ${fullType}`;
													} catch (error) {
														console.error(`Error getting full type for ${param.name}:`, error);
														return `${param.name}: ${param.type}`;
													}
												}
												return `${param.name}: ${param.type}`;
											})
											.join(', ');

										fullTypeInfoString = typeDefinitions;
									}
								} else {
									// Fallback to simple type strings
									fullTypeInfoString = params
										.filter(param => !param.isOptional)
										.map(param => `${param.name}: ${param.type}`)
										.join(', ');
								}
							}
						} catch (error) {
							console.error('Error creating detailed type information:', error);
							// Fallback to simple parameter names and types
							fullTypeInfoString = params
								.filter(param => !param.isOptional)
								.map(param => `${param.name}: ${param.type}`)
								.join(', ');
						}

						// Extract all type definitions from the file and its imports
						let allTypeDefinitions: string[] = [];
						try {
							const langService = createTsLanguageService(document.fileName);
							if (langService && langService.getProgram()) {
								const program = langService.getProgram();
								if (program) {
									const typeChecker = program.getTypeChecker();
									const sourceFile = program.getSourceFile(document.fileName);
									if (sourceFile) {
										const processedFiles = new Set<string>();
										allTypeDefinitions = extractTypeDefinitions(
											sourceFile,
											typeChecker,
											program,
											processedFiles
										);
									}
								}
							}
						} catch (error) {
							console.error('Error extracting type definitions:', error);
						}

						// Get AI-generated function call with complete type information and file content
						const aiGeneratedCode = await askAIForFunctionCall(
							fullTypeInfoString,
							functionName,
							document.getText(),
							allTypeDefinitions,
							context
						);

						// Add the AI-generated code above the function
						const insertPosition = new vscode.Position(lineNumber, 0);
						const indentation = document.lineAt(lineNumber).text.match(/^\s*/)?.[0] || '';

						// Add special marker comments around the generated code, now with function name
						const codeWithMarkers =
							`${indentation}// FUNCTION-RUN-GENERATED-CODE-START:${functionName}
${indentation}${aiGeneratedCode}
${indentation}// FUNCTION-RUN-GENERATED-CODE-END:${functionName}

`;

						// If there are existing generated markers for this function, find and replace them
						if (codelensProvider.hasGeneratedCode(document, functionName)) {
							const markerRange = codelensProvider.getFunctionMarkerRange(document, functionName);
							if (markerRange) {
								// For existing markers, don't add extra newline in the template
								const codeWithMarkersNoExtraLine =
									`${indentation}// FUNCTION-RUN-GENERATED-CODE-START:${functionName}
${indentation}${aiGeneratedCode}
${indentation}// FUNCTION-RUN-GENERATED-CODE-END:${functionName}
`;

								const edit = new vscode.WorkspaceEdit();
								edit.replace(document.uri, markerRange, codeWithMarkersNoExtraLine);
								await vscode.workspace.applyEdit(edit);
							}
						} else {
							// Use the insertPosition we already defined above (just above the function)
							const edit = new vscode.WorkspaceEdit();
							edit.insert(document.uri, insertPosition, codeWithMarkers);
							await vscode.workspace.applyEdit(edit);
						}

						await document.save();

						// Show message about parameter generation
						vscode.window.showInformationMessage(`Generated parameters for ${functionName}`);
					} else {
						// Just run the existing function without generating new parameters
						vscode.window.showInformationMessage(`Running ${functionName}`);
					}

					// Execute Quokka command to run the file
					await vscode.commands.executeCommand('quokka.makeQuokkaFromExistingFile');

				} finally {
					// Make sure we always mark the function as done processing, even if there's an error
					codelensProvider.endProcessing(docUri.fsPath, functionName);
				}
			} catch (error) {
				// Mark the function as no longer processing in case of error
				codelensProvider.endProcessing(docUri.fsPath, functionName);

				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error('Error in function-run extension:', error);
				console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace available');
				console.error('Document URI:', docUri?.toString() || 'undefined');
				console.error('Function name:', functionName || 'undefined');
				console.error('Line number:', lineNumber);
				vscode.window.showErrorMessage(`Error running function: ${errorMessage}`);
			}
		})
	];

	context.subscriptions.push(...disposables);
	console.log('Extension fully activated and ready');
}

// This method is called when your extension is deactivated
export function deactivate() { }
