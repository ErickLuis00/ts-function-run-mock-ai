# Run TypeScript Function

A VS Code extension that adds a "Run Function" button above TypeScript functions to quickly test them with Quokka.js.

## Features

- Adds a CodeLens button above each TypeScript function
- When clicked, it automatically:
  - Adds a `console.log` statement above the function to capture its output
  - Runs the file with Quokka.js to see the results instantly

## Requirements

- Visual Studio Code 1.99.0 or higher
- [Quokka.js](https://marketplace.visualstudio.com/items?itemName=WallabyJs.quokka-vscode) extension must be installed

## How to Use

1. Open any TypeScript file
2. You'll see a "► Run Function" button above each function
3. Click the button to run the function with Quokka
4. The function will be executed and its result will be displayed in the Quokka output

## Extension Settings

This extension contributes the following settings:

* `function-run.enableCodeLens`: Enable/disable the CodeLens for running functions

## Known Issues

- Requires functions to be runnable without parameters or with default parameters
- May not detect complex function patterns with unusual formatting

## Release Notes

### 0.0.1

Initial release

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
