/**
 * @fileoverview Utility to load config files
 * @author Nicholas C. Zakas
 */

"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const path = require("node:path");
const fs = require("node:fs/promises");
const findUp = require("find-up");
const { pathToFileURL } = require("node:url");
const debug = require("debug")("eslint:config-loader");
const { FlatConfigArray } = require("../config/flat-config-array");

//-----------------------------------------------------------------------------
// Types
//-----------------------------------------------------------------------------

/**
 * @typedef {import("../shared/types").FlatConfigObject} FlatConfigObject
 * @typedef {import("../shared/types").FlatConfigArray} FlatConfigArray
 * @typedef {Object} ConfigLoaderOptions
 * @property {string|false|undefined} configFilePath The path to the config file to use.
 * @property {string} cwd The current working directory.
 * @property {boolean} ignoreEnabled Indicates if ignore patterns should be honored.
 * @property {FlatConfigArray} [baseConfig] The base config to use.
 * @property {Array<FlatConfigObject>} [defaultConfigs] The default configs to use.
 * @property {Array<string>} [ignorePatterns] The ignore patterns to use.
 * @property {FlatConfigObject|Array<FlatConfigObject>} overrideConfig The override config to use.
 */

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

const FLAT_CONFIG_FILENAMES = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs"
];

const importedConfigFileModificationTime = new Map();

/**
 * Asserts that the given file path is valid.
 * @param {string} filePath The file path to check.
 * @returns {void}
 * @throws {Error} If `filePath` is not a non-empty string.
 */
function assertValidFilePath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        throw new Error("'filePath' must be a non-empty string");
    }
}


/**
 * Load the config array from the given filename.
 * @param {string} filePath The filename to load from.
 * @returns {Promise<any>} The config loaded from the config file.
 */
async function loadConfigFile(filePath) {

    debug(`Loading config from ${filePath}`);

    const fileURL = pathToFileURL(filePath);

    debug(`Config file URL is ${fileURL}`);

    const mtime = (await fs.stat(filePath)).mtime.getTime();

    /*
     * Append a query with the config file's modification time (`mtime`) in order
     * to import the current version of the config file. Without the query, `import()` would
     * cache the config file module by the pathname only, and then always return
     * the same version (the one that was actual when the module was imported for the first time).
     *
     * This ensures that the config file module is loaded and executed again
     * if it has been changed since the last time it was imported.
     * If it hasn't been changed, `import()` will just return the cached version.
     *
     * Note that we should not overuse queries (e.g., by appending the current time
     * to always reload the config file module) as that could cause memory leaks
     * because entries are never removed from the import cache.
     */
    fileURL.searchParams.append("mtime", mtime);

    /*
     * With queries, we can bypass the import cache. However, when import-ing a CJS module,
     * Node.js uses the require infrastructure under the hood. That includes the require cache,
     * which caches the config file module by its file path (queries have no effect).
     * Therefore, we also need to clear the require cache before importing the config file module.
     * In order to get the same behavior with ESM and CJS config files, in particular - to reload
     * the config file only if it has been changed, we track file modification times and clear
     * the require cache only if the file has been changed.
     */
    if (importedConfigFileModificationTime.get(filePath) !== mtime) {
        delete require.cache[filePath];
    }

    const config = (await import(fileURL)).default;

    importedConfigFileModificationTime.set(filePath, mtime);

    return config;
}

/**
 * Calculates the config array for this run based on inputs.
 * @param {string} configFilePath The absolute path to the config file to use if not overridden.
 * @param {string} basePath The base path to use for relative paths in the config file.
 * @param {ConfigLoaderOptions} options The options to use when loading configuration files.
 * @returns {Promise<FlatConfigArray>} The config array for `eslint`.
 */
async function calculateConfigArray(configFilePath, basePath, options) {

    const {
        cwd,
        baseConfig,
        ignoreEnabled,
        ignorePatterns,
        overrideConfig,
        defaultConfigs = []
    } = options;

    debug(`Calculating config array from config file ${configFilePath} and base path ${basePath}`);

    const configs = new FlatConfigArray(baseConfig || [], { basePath, shouldIgnore: ignoreEnabled });

    // load config file
    if (configFilePath) {

        debug(`Loading config file ${configFilePath}`);
        const fileConfig = await loadConfigFile(configFilePath);

        if (Array.isArray(fileConfig)) {
            configs.push(...fileConfig);
        } else {
            configs.push(fileConfig);
        }
    }

    // add in any configured defaults
    configs.push(...defaultConfigs);

    // append command line ignore patterns
    if (ignorePatterns && ignorePatterns.length > 0) {

        let relativeIgnorePatterns;

        /*
         * If the config file basePath is different than the cwd, then
         * the ignore patterns won't work correctly. Here, we adjust the
         * ignore pattern to include the correct relative path. Patterns
         * passed as `ignorePatterns` are relative to the cwd, whereas
         * the config file basePath can be an ancestor of the cwd.
         */
        if (basePath === cwd) {
            relativeIgnorePatterns = ignorePatterns;
        } else {

            const relativeIgnorePath = path.relative(basePath, cwd);

            relativeIgnorePatterns = ignorePatterns.map(pattern => {
                const negated = pattern.startsWith("!");
                const basePattern = negated ? pattern.slice(1) : pattern;

                return (negated ? "!" : "") +
                    path.posix.join(relativeIgnorePath, basePattern);
            });
        }

        /*
         * Ignore patterns are added to the end of the config array
         * so they can override default ignores.
         */
        configs.push({
            ignores: relativeIgnorePatterns
        });
    }

    if (overrideConfig) {
        if (Array.isArray(overrideConfig)) {
            configs.push(...overrideConfig);
        } else {
            configs.push(overrideConfig);
        }
    }

    await configs.normalize();

    return configs;
}


//-----------------------------------------------------------------------------
// Exports
//-----------------------------------------------------------------------------

/**
 * Encapsulates the loading and caching of configuration files when looking up
 * from the file being linted.
 */
class ConfigLoader {

    /**
     * Map of config file paths to the config arrays for those directories.
     * @type {Map<string, FlatConfigArray>}
     */
    #configArrays = new Map();

    /**
     * Map of absolute directory names to the config file paths for those directories.
     * @type {Map<string, {configFilePath:string,basePath:string}>}
     */
    #configFilePaths = new Map();

    /**
     * The options to use when loading configuration files.
     * @type {ConfigLoaderOptions}
     */
    #options;

    /**
     * Creates a new instance.
     * @param {ConfigLoaderOptions} options The options to use when loading configuration files.
     */
    constructor(options) {
        this.#options = options;
    }

    /**
     * Determines which config file to use. This is determined by seeing if an
     * override config file was specified, and if so, using it; otherwise, as long
     * as override config file is not explicitly set to `false`, it will search
     * upwards from the cwd for a file named `eslint.config.js`.
     * @param {string} fromDirectory The directory from which to start searching.
     * @returns {{configFilePath:string|undefined,basePath:string}} Location information for
     *      the config file.
     */
    async #locateConfigFileToUse(fromDirectory) {

        // check cache first
        if (this.#configFilePaths.has(fromDirectory)) {
            return this.#configFilePaths.get(fromDirectory);
        }

        // determine where to load config file from
        let configFilePath;
        const {
            cwd,
            configFilePath: overrideConfigFilePath
        } = this.#options;
        let basePath = cwd;

        if (typeof overrideConfigFilePath === "string") {
            debug(`Override config file path is ${overrideConfigFilePath}`);
            configFilePath = path.resolve(cwd, overrideConfigFilePath);
            basePath = cwd;
        } else if (overrideConfigFilePath !== false) {
            debug("Searching for eslint.config.js");
            configFilePath = await findUp(
                FLAT_CONFIG_FILENAMES,
                { cwd: fromDirectory }
            );

            if (!configFilePath) {
                const error = new Error("Could not find config file.");

                error.messageTemplate = "config-file-missing";
                throw error;
            }

            basePath = path.resolve(cwd, path.dirname(configFilePath));
        }

        // cache the result
        this.#configFilePaths.set(fromDirectory, { configFilePath, basePath });

        return {
            configFilePath,
            basePath
        };

    }

    /**
     * Calculates the config array for this run based on inputs.
     * @param {string} configFilePath The absolute path to the config file to use if not overridden.
     * @param {string} basePath The base path to use for relative paths in the config file.
     * @returns {Promise<FlatConfigArray>} The config array for `eslint`.
     */
    async #calculateConfigArray(configFilePath, basePath) {

        // check for cached version first
        if (this.#configArrays.has(configFilePath)) {
            return this.#configArrays.get(configFilePath);
        }

        const configs = await calculateConfigArray(configFilePath, basePath, this.#options);

        // cache the config array for this instance
        this.#configArrays.set(configFilePath, configs);

        return configs;
    }

    /**
     * Returns the config file path for the given file. This will either use
     * the override config file that was specified in the constructor options or
     * search for a config file from the directory of the file being linted.
     * @param {string} filePath The file path to get the config file path for.
     * @returns {Promise<string|undefined>} The config file path or `undefined` if not found.
     * @throws {Error} If `filePath` is not a non-empty string.
     * @throws {Error} If `filePath` is not an absolute path.
     */
    findConfigFileForFile(filePath) {

        assertValidFilePath(filePath);

        return this.findConfigFileForDirectory(path.dirname(filePath));
    }

    /**
     * Returns the config file path for the given directory. This will either use
     * the override config file that was specified in the constructor options or
     * search for a config file from the directory.
     * @param {string} dirPath The file directory path to get the config file path for.
     * @returns {Promise<string|undefined>} The config file path or `undefined` if not found.
     * @throws {Error} If `dirPath` is not a non-empty string.
     * @throws {Error} If `dirPath` is not an absolute path.
     */
    async findConfigFileForDirectory(dirPath) {

        assertValidFilePath(dirPath);

        const absoluteDirPath = path.resolve(this.#options.cwd, dirPath);
        const { configFilePath } = await this.#locateConfigFileToUse(absoluteDirPath);

        return configFilePath;
    }

    /**
     * Returns a configuration object for the given file based on the CLI options.
     * This is the same logic used by the ESLint CLI executable to determine
     * configuration for each file it processes.
     * @param {string} filePath The path of the file or directory to retrieve config for.
     * @returns {Promise<ConfigData|undefined>} A configuration object for the file
     *      or `undefined` if there is no configuration data for the file.
     */
    loadConfigArrayForFile(filePath) {

        assertValidFilePath(filePath);

        debug(`Calculating config for file ${filePath}`);

        return this.loadConfigArrayForDirectory(path.dirname(filePath));
    }

    /**
     * Returns a configuration object for the given directory based on the CLI options.
     * This is the same logic used by the ESLint CLI executable to determine
     * configuration for each file it processes.
     * @param {string} dirPath The path of the directory to retrieve config for.
     * @returns {Promise<ConfigData|undefined>} A configuration object for the directory
     *      or `undefined` if there is no configuration data for the directory.
     */
    async loadConfigArrayForDirectory(dirPath) {

        assertValidFilePath(dirPath);

        debug(`Calculating config for directory ${dirPath}`);

        const absoluteDirPath = path.resolve(this.#options.cwd, dirPath);
        const { configFilePath, basePath } = await this.#locateConfigFileToUse(absoluteDirPath);

        debug(`Using config file ${configFilePath} and base path ${basePath}`);
        return this.#calculateConfigArray(configFilePath, basePath);
    }

    /**
     * Returns a configuration array for the given file based on the CLI options.
     * This is a synchronous operation and does not read any files from disk. It's
     * intended to be used in locations where we know the config file has already
     * been loaded and we just need to get the configuration for a file.
     * @param {string} filePath The path of the file to retrieve a config object for.
     * @returns {ConfigData|undefined} A configuration object for the file
     *     or `undefined` if there is no configuration data for the file.
     * @throws {Error} If `filePath` is not a non-empty string.
     * @throws {Error} If `filePath` is not an absolute path.
     * @throws {Error} If the config file was not already loaded.
     */
    getCachedConfigArrayForFile(filePath) {
        assertValidFilePath(filePath);

        debug(`Looking up cached config for ${filePath}`);

        return this.getCachedConfigArrayForDirectory(path.dirname(filePath));
    }

    /**
     * Returns a configuration array for the given directory based on the CLI options.
     * This is a synchronous operation and does not read any files from disk. It's
     * intended to be used in locations where we know the config file has already
     * been loaded and we just need to get the configuration for a file.
     * @param {string} dirPath The path of the directory to retrieve a config object for.
     * @returns {ConfigData|undefined} A configuration object for the directory
     *     or `undefined` if there is no configuration data for the directory.
     * @throws {Error} If `dirPath` is not a non-empty string.
     * @throws {Error} If `dirPath` is not an absolute path.
     * @throws {Error} If the config file was not already loaded.
     */
    getCachedConfigArrayForDirectory(dirPath) {
        assertValidFilePath(dirPath);

        debug(`Looking up cached config for ${dirPath}`);

        const absoluteDirPath = path.resolve(this.#options.cwd, dirPath);

        if (!this.#configFilePaths.has(absoluteDirPath)) {
            throw new Error(`Could not find config file for ${dirPath}`);
        }

        const { configFilePath } = this.#configFilePaths.get(absoluteDirPath);
        return this.#configArrays.get(configFilePath);
    }

}

/**
 * Encapsulates the loading and caching of configuration files when looking up
 * from the current working directory.
 */
class LegacyConfigLoader extends ConfigLoader {

    /**
     * The options to use when loading configuration files.
     * @type {ConfigLoaderOptions}
     */
    #options;

    /**
     * The cached config file path for this instance.
     * @type {{configFilePath:string,basePath:string}|undefined}
     */
    #configFilePath;

    /**
     * The cached config array for this instance.
     * @type {FlatConfigArray}
     */
    #configArray;

    /**
     * Creates a new instance.
     * @param {ConfigLoaderOptions} options The options to use when loading configuration files.
     */
    constructor(options) {
        super(options);
        this.#options = options;
    }

    /**
     * Determines which config file to use. This is determined by seeing if an
     * override config file was specified, and if so, using it; otherwise, as long
     * as override config file is not explicitly set to `false`, it will search
     * upwards from the cwd for a file named `eslint.config.js`.
     * @param {string} fromDirectory The directory from which to start searching.
     * @returns {{configFilePath:string|undefined,basePath:string}} Location information for
     *      the config file.
     */
    async #locateConfigFileToUse(fromDirectory) {

        // check cache first
        if (this.#configFilePath) {
            return this.#configFilePath;
        }

        // determine where to load config file from
        let configFilePath;
        const {
            cwd,
            configFilePath: overrideConfigFilePath
        } = this.#options;
        let basePath = cwd;

        if (typeof overrideConfigFilePath === "string") {
            debug(`Override config file path is ${overrideConfigFilePath}`);
            configFilePath = path.resolve(cwd, overrideConfigFilePath);
            basePath = cwd;
        } else if (overrideConfigFilePath !== false) {
            debug("Searching for eslint.config.js");
            configFilePath = await findUp(
                FLAT_CONFIG_FILENAMES,
                { cwd: fromDirectory }
            );

            if (!configFilePath) {
                const error = new Error("Could not find config file.");

                error.messageTemplate = "config-file-missing";
                throw error;
            }

            basePath = path.resolve(cwd, path.dirname(configFilePath));
        }

        // cache the result
        this.#configFilePath = { configFilePath, basePath };

        return {
            configFilePath,
            basePath
        };

    }

    /**
     * Calculates the config array for this run based on inputs.
     * @param {string} configFilePath The absolute path to the config file to use if not overridden.
     * @param {string} basePath The base path to use for relative paths in the config file.
     * @returns {Promise<FlatConfigArray>} The config array for `eslint`.
     */
    async #calculateConfigArray(configFilePath, basePath) {

        // check for cached version first
        if (this.#configArray) {
            return this.#configArray;
        }

        const configs = await calculateConfigArray(configFilePath, basePath, this.#options);

        // cache the config array for this instance
        this.#configArray = configs;

        return configs;
    }


    /**
     * Returns the config file path for the given directory. This will either use
     * the override config file that was specified in the constructor options or
     * search for a config file from the directory of the file being linted.
     * @param {string} dirPath The directory path to get the config file path for.
     * @returns {Promise<string|undefined>} The config file path or `undefined` if not found.
     * @throws {Error} If `fileOrDirPath` is not a non-empty string.
     * @throws {Error} If `fileOrDirPath` is not an absolute path.
     */
    async findConfigFileForDirectory(dirPath) {

        assertValidFilePath(dirPath);

        const absoluteDirPath = path.resolve(this.#options.cwd, dirPath);
        const { configFilePath } = await this.#locateConfigFileToUse(absoluteDirPath);

        return configFilePath;
    }

    /**
     * Returns a configuration object for the given file based on the CLI options.
     * This is the same logic used by the ESLint CLI executable to determine
     * configuration for each file it processes.
     * @param {string} dirPath The path of the directory to retrieve config for.
     * @returns {Promise<ConfigData|undefined>} A configuration object for the file
     *      or `undefined` if there is no configuration data for the file.
     */
    async loadConfigArrayForDirectory(dirPath) {

        assertValidFilePath(dirPath);

        debug(`Calculating config for ${dirPath}`);

        const absoluteDirPath = path.resolve(this.#options.cwd, dirPath);
        const { configFilePath, basePath } = await this.#locateConfigFileToUse(absoluteDirPath);

        debug(`Using config file ${configFilePath} and base path ${basePath}`);
        return this.#calculateConfigArray(configFilePath, basePath);
    }

    /**
     * Returns a configuration array for the given directory based on the CLI options.
     * This is a synchronous operation and does not read any files from disk. It's
     * intended to be used in locations where we know the config file has already
     * been loaded and we just need to get the configuration for a file.
     * @param {string} dirPath The path of the directory to retrieve a config object for.
     * @returns {ConfigData|undefined} A configuration object for the file
     *     or `undefined` if there is no configuration data for the file.
     * @throws {Error} If `dirPath` is not a non-empty string.
     * @throws {Error} If `dirPath` is not an absolute path.
     * @throws {Error} If the config file was not already loaded.
     */
    getCachedConfigArrayForDirectory(dirPath) {
        assertValidFilePath(dirPath);

        debug(`Looking up cached config for ${dirPath}`);

        if (!this.#configArray) {
            throw new Error(`Could not find config file for ${dirPath}`);
        }

        return this.#configArray;
    }
}

module.exports = { ConfigLoader, LegacyConfigLoader };