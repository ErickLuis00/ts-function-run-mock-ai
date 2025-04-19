# Change Log

All notable changes to the "Function Run" extension will be documented in this file.

## \[1.0.0\] - 2023-06-15

### Added

* AI-powered mock data generation for function parameters
* Integration with OpenAI API for intelligent parameter values
* Multiple CodeLens buttons:
  * "Generate Mock and Run" - Create mock data and run with Quokka
  * "Run Function" - Execute with existing mock data
  * "Remove Function Call" - Clean up generated code
  * "Stop Run" - Stop Quokka execution
* Support for complex TypeScript types including interfaces and objects
* Type extraction from imports and project files
* Function name embedding in markers for more reliable code management
* Settings for OpenAI API key and proxy configuration

### Changed

* Improved type analysis for better mock data generation
* Enhanced marker format to associate generated code with specific functions

### Fixed

* Handling of optional parameters in function signatures
* Better detection of function declarations in various formats


