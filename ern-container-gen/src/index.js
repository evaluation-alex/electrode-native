// Node
import child_process from 'child_process';
import fs from 'fs';
import http from 'http';
import shell from 'shelljs';
import Mustache from 'mustache';
import Ora from 'ora';
import readDir from 'fs-readdir-recursive';
import _ from 'lodash';

const exec = child_process.exec;
// 3rd party

let mustacheView = {};
let containerBaseManifest;

const ROOT_DIR = shell.pwd();
const pluginConfigFileName = 'config.json';
const gitFolderRe = /.*\/(.*).git/;
const npmScopeModuleRe = /(@.*)\/(.*)/;
const npmModuleRe = /(.*)@(.*)/;
const fileRe = /^file:\/\//;

const DEFAULT_NAMESPACE = 'com.walmartlabs.ern';
const DEFAULT_MAVEN_REPO_URL = `file://${process.env['HOME']}/.m2/repository`;

// Path to ern platform root folder
const ERN_PATH = `${process.env['HOME']}/.ern`;

let log;

//=============================================================================
// Async wrappers
//=============================================================================

async function readFile(filename, enc) {
    return new Promise((resolve, reject) => {
        fs.readFile(filename, enc, (err, res) => {
            if (err) reject(err);
            else resolve(res);
        });
    });
}

async function writeFile(filename, data) {
    return new Promise((resolve, reject) => {
        fs.writeFile(filename, data, (err, res) => {
            if (err) reject(err);
            else resolve(res);
        });
    });
}

async function shellExec(command) {
    return new Promise((resolve, reject) => {
        shell.exec(command, {async: true}, (code, stdout, stderr) => {
            if (code !== 0) {
                log.error(stderr);
                reject();
            }
            else resolve();
        });
    });
}

async function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            resolve(res);
        }).on('error', e => {
            reject(e);
        });
    });
}

//=============================================================================
// Mustache related utilities
//=============================================================================

// Mustache render using a template file
// filename: Path to the template file
// view: Mustache view to apply to the template
// returns: Rendered string output
async function mustacheRenderUsingTemplateFile(filename, view) {
    return readFile(filename, 'utf8')
        .then(template => Mustache.render(template, view));
}

// Mustache render to an output file using a template file
// templateFilename: Path to the template file
// view: Mustache view to apply to the template
// outputFile: Path to the output file
async function mustacheRenderToOutputFileUsingTemplateFile(templateFilename, view, outputFile) {
    return mustacheRenderUsingTemplateFile(templateFilename, view).then(output => {
        return writeFile(outputFile, output);
    });
}

//=============================================================================
// container-gen utilities
//=============================================================================

//
// Returns the base path of a given plugin generation config
function getPluginConfigPath(plugin, pluginsConfigPath) {
    return `${pluginsConfigPath}/${plugin.name}`;
}

//
// Get the generation config of a given plugin
// plugin: A plugin object
// pluginsConfigPath : Path to plugins config
// Sample plugin object :
// {
//   name: "react-native-code-push",
//   version: "1.2.3"
// }
async function getPluginConfig(plugin, pluginsConfigPath) {
    let result = {};
    const pluginConfigPath = getPluginConfigPath(plugin, pluginsConfigPath);

    // If there is a base file (common to all versions) use it and optionally
    // patch it with specific version config (if present)
    if (fs.existsSync(`${pluginConfigPath}/${pluginConfigFileName}`)) {
        result = await readFile(`${pluginConfigPath}/${pluginConfigFileName}`)
            .then(JSON.parse);
    }
    // No config, assume apigen module (temporary)
    // we need to patch the build.gradle file accordingly to update
    // birdge dependency compile statement with platform version
    else {
        log.info(`No config.json file for ${plugin.name}. Assuming apigen module`);
        result = {
            origin: {
                type: 'npm',
                scope: `${npmScopeModuleRe.exec(`${plugin.name}`)[1]}`,
                name: `${npmScopeModuleRe.exec(`${plugin.name}`)[2]}`
            },
            root: 'android',
            uploadArchives: {
                moduleName: 'lib'
            },
            transform: [
                {file: 'android/lib/build.gradle'}
            ]
        };
    }

    // If there is no specified version, assume plugin version by default
    if (!result.origin.version) {
        // Handle specific rn case
        if (plugin.name === 'react-native') {
            result.origin.version = `v${plugin.version}`;
        } else {
            result.origin.version = plugin.version;
        }
    }

    return result;
}

// Yarn add a given dependency
async function yarnAdd(name, version) {
    return new Promise((resolve, reject) => {
        exec(version ? `yarn add ${name}@${version}` : `yarn add ${name}`,
            (err, stdout, stderr) => {
                if (err) {
                    log.error(err);
                    reject(err);
                }
                if (stderr) {
                    if (!stderr.startsWith('warning')) {
                        log.error(stderr);
                    }
                }
                if (stdout) {
                    log.info(stdout);
                    resolve(stdout);
                }
            });
    });
}

async function gitClone(url, branch) {
    return new Promise((resolve, reject) => {
        exec(`git clone --branch ${branch} --depth 1 ${url}`,
            (err, stdout, stderr) => {
                // Git seems to send stuff to stderr :(
                if (err) {
                    log.error(err);
                    reject(err);
                } else {
                    log.info(stdout ? stdout : stderr);
                    resolve(stdout ? stdout : stderr);
                }
            });
    });
}

//
// Download the plugin source given a plugin origin
// pluginOrigin: A plugin origin object
// Sample plugin origin objects :
// {
//  "type": "git",
//  "url": "https://github.com/aoriani/ReactNative-StackTracer.git",
//  "version": "0.1.1"
// }
//
// {
//  "type": "npm",
//  "name": "react-native-code-push",
//  "version": "1.16.1-beta"
// }
//
// Note: The plugin will be downloaded locally to the current folder
// For npm origin it will be put in node_modules folder
// For git origin it will be put directly at the root in a folder named after
// the git repo as one would expect
//
// Returns: Absolute path to where the plugin was installed
async function downloadPluginSource(pluginOrigin) {
    let downloadPath;
    if (pluginOrigin.type === 'npm') {
        if (pluginOrigin.scope) {
            await yarnAdd(`${pluginOrigin.scope}/${pluginOrigin.name}`, pluginOrigin.version);
            downloadPath = `node_modules/${pluginOrigin.scope}/${pluginOrigin.name}`;
        } else {
            await yarnAdd(pluginOrigin.name, pluginOrigin.version);
            downloadPath = `node_modules/${pluginOrigin.name}`;
        }
    } else if (pluginOrigin.type === 'git') {
        if (pluginOrigin.version) {
            await gitClone(pluginOrigin.url, pluginOrigin.version);
            downloadPath = gitFolderRe.exec(`${pluginOrigin.url}`)[1];
        }
    }

    return Promise.resolve(`${shell.pwd()}/${downloadPath}`);
}

// Build the plugin from source and invoke uploadArchives task to publish plugin
// This is only used for final generated container project
// All other plugins are not published but their source code is directly injected
// in the container
async function buildAndUploadArchive(moduleName) {
    let cmd = `./gradlew ${moduleName}:uploadArchives `;
    return new Promise((resolve, reject) => {
        exec(cmd,
            (err, stdout, stderr) => {
                if (err) {
                    log.error(err);
                    reject(err);
                }
                if (stderr) {
                    log.info(stderr);
                }
                if (stdout) {
                    log.info(stdout);
                    resolve(stdout);
                }
            });
    });
}

//=============================================================================
// Misc/general utilities
//=============================================================================

// Given a string returns the same string with its first letter capitalized
function capitalizeFirstLetter(string) {
    return `${string.charAt(0).toUpperCase()}${string.slice(1)}`;
}

// Promisify ora spinner
// there is already a promise method on ora spinner, unfortunately it does
// not return the wrapped promise so that's utterly useless !
async function spin(msg, prom, options) {
    const spinner = new Ora(options ? options : msg);
    spinner.start();

    try {
        let result = await prom;
        spinner.succeed();
        return result;
    } catch (e) {
        spinner.fail(e);
        throw e;
    }
}

//=============================================================================
// ern-container-gen core logic
//=============================================================================

function getUnscopedModuleName(pluginName) {
    return npmScopeModuleRe.test(pluginName) ?
        npmScopeModuleRe.exec(`${pluginName}`)[2]
        : pluginName;
}

async function buildPluginsViews(plugins, pluginsConfigPath) {
    try {
        let pluginsView = [];

        for (const plugin of plugins) {
            if (plugin.name === 'react-native') {
                continue;
            }
            let pluginConfig = await getPluginConfig(plugin, pluginsConfigPath);

            if (pluginConfig.pluginHook) {
                log.info(`Hooking ${plugin.name} plugin`);
                pluginsView.push({
                    "name": pluginConfig.pluginHook.name,
                    "lcname": pluginConfig.pluginHook.name.charAt(0).toLowerCase() +
                    pluginConfig.pluginHook.name.slice(1),
                    "configurable": pluginConfig.pluginHook.configurable
                });
            }
        }

        mustacheView.plugins = pluginsView;

        mustacheView.pluginCompile = [];
        const reactNativePlugin = _.find(plugins, p => p.name === 'react-native');
        if (reactNativePlugin) {
            log.info(`Will inject: compile 'com.facebook.react:react-native:${reactNativePlugin.version}'`);
            mustacheView.pluginCompile.push({
                "compileStatement": `compile 'com.facebook.react:react-native:${reactNativePlugin.version}'`
            });
        }
    } catch (e) {
        log.error("[buildPluginsViews] Something went wrong: " + e);
        throw e;
    }
}

async function addPluginHookClasses(plugins, paths) {
    try {
        log.info(`[=== Adding plugin hook classes ===]`);

        for (const plugin of plugins) {
            if (plugin.name === 'react-native') {
                continue;
            }
            let pluginConfig = await getPluginConfig(plugin, paths.containerPluginsConfig);
            if (pluginConfig.pluginHook) {
                log.info(`Adding ${pluginConfig.pluginHook.name}.java`);
                shell.cp(`${paths.containerPluginsConfig}/${plugin.name}/${pluginConfig.pluginHook.name}.java`,
                    `${paths.outFolder}/lib/src/main/java/com/walmartlabs/ern/container/plugins/`);
            }
        }

        log.info(`[=== Done adding plugin hook classes ===]`);
    } catch (e) {
        log.error("[addPluginHookClasses] Something went wrong: " + e);
        throw e;
    }
}

async function fillContainerHull(plugins, miniApps, paths) {
    try {
        log.info(`[=== Starting container hull filling ===]`);

        shell.cd(`${ROOT_DIR}`);

        log.info(`Creating out folder and copying Container Hull to it`);
        shell.cp('-R', `${paths.containerHull}/android`, `${paths.outFolder}`);

        await buildPluginsViews(plugins, paths.containerPluginsConfig);
        await addPluginHookClasses(plugins, paths);

        log.info(`Patching hull`);
        const files = readDir(`${paths.outFolder}`, (f) => !f.endsWith('.jar'));
        for (const file of files) {
            await mustacheRenderToOutputFileUsingTemplateFile(
                `${paths.outFolder}/${file}`, mustacheView, `${paths.outFolder}/${file}`);
        }

        for (const plugin of plugins) {
            if (plugin.name === 'react-native') {
                continue;
            }
            let pluginConfig = await getPluginConfig(plugin, paths.containerPluginsConfig);
            shell.cd(`${paths.tmpFolder}`);
            let pluginSourcePath = await spin(`Injecting ${plugin.name} code in container`,
                downloadPluginSource(pluginConfig.origin));
            shell.cd(`${pluginSourcePath}/${pluginConfig.root}`);
            shell.cp('-R', `${pluginConfig.uploadArchives.moduleName}/src/main/java`, `${paths.outFolder}/lib/src/main`);
        }

        // Create mini app activities
        log.info(`Creating miniapp activities`);
        for (const miniApp of miniApps) {
            let miniAppName = getUnscopedModuleName(miniApp.name);
            let pascalCaseMiniAppName = capitalizeFirstLetter(miniAppName);
            let tmpMiniAppView = {
                miniAppName,
                pascalCaseMiniAppName
            };

            let activityFileName = `${pascalCaseMiniAppName}Activity.java`;

            log.info(`Creating ${activityFileName}`);
            await mustacheRenderToOutputFileUsingTemplateFile(
                `${paths.containerTemplates}/android/MiniAppActivity.mustache`,
                tmpMiniAppView,
                `${paths.outFolder}/lib/src/main/java/com/walmartlabs/ern/container/miniapps/${activityFileName}`);
        }

        log.info(`[=== Completed container hull filling ===]`);
    } catch (e) {
        log.error("[fillContainerHull] Something went wrong: " + e);
        throw e;
    }
}

function clearReactPackagerCache() {
    shell.rm('-rf', `${process.env['TMPDIR']}/react-*`);
}

async function reactNativeBundle(paths) {
    return new Promise((resolve, reject) => {
        exec(`react-native bundle \
          --entry-file=index.android.js \
          --dev=false --platform=android \
          --bundle-output=${paths.outFolder}/lib/src/main/assets/index.android.bundle \
          --assets-dest=${paths.outFolder}/lib/src/main/res`,
            (err, stdout, stderr) => {
                if (err) {
                    log.error(err);
                    reject(err);
                }
                if (stderr) {
                    log.error(stderr);
                }
                if (stdout) {
                    log.info(stdout);
                    resolve(stdout);
                }
            });
    });
}

export async function generateMiniAppsComposite(miniapps, folder, {verbose, plugins}) {
    if (!log) {
        log = require('console-log-level')({
            prefix: () => '[ern-container-gen]',
            level: verbose ? 'info' : 'warn'
        });
    }

    shell.mkdir('-p', folder);
    shell.cd(folder);

    let content = "";
    for (const miniapp of miniapps) {
        const miniAppName = miniapp.scope ? `@${miniapp.scope}/${miniapp.name}`
            : miniapp.name;
        content += `import '${miniAppName}'\n`;
        await spin(`Retrieving and installing ${miniAppName}@${miniapp.version}`,
            yarnAdd(miniAppName, miniapp.version));
    }

    // If code push plugin is present we need to do some additional work
    if (plugins) {
        const codePushPlugin = _.find(plugins, p => p.name === 'react-native-code-push');
        if (codePushPlugin) {
            await yarnAdd(codePushPlugin.name, codePushPlugin.version);
            content += `import codePush from "react-native-code-push"\n`;
            content += `codePush.sync()`;

            // We need to add some info to package.json for CodePush
            // In order to run, code push needs to find the following in package.json
            // - name & version
            // - react-native in the dependency block
            // TODO :For now we hardcode these values for demo purposes. That being said it
            // might not be needed to do something better because it seems like
            // code push is not making a real use of this data
            // Investigate further.
            // https://github.com/Microsoft/code-push/blob/master/cli/script/command-executor.ts#L1246
            const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
            packageJson.dependencies['react-native'] =
                _.find(plugins, p => p.name === 'react-native').version;
            packageJson.name = "container";
            packageJson.version = "0.0.1";
            fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
        }
    }

    log.info(`writing index.android.js`);
    await writeFile('./index.android.js', content);
}

async function bundleMiniApps(miniapps, paths, plugins) {
    try {
        log.info(`[=== Starting mini apps bundling ===]`);

        // Specific case where we use container gen to generate
        // container for runner and we want to bundle the local miniapp
        if ((miniapps.length === 1) && (miniapps[0].localPath)) {
            shell.cd(miniapps[0].localPath);
        }
        // Generic case
        else {
            await generateMiniAppsComposite(miniapps, paths.compositeMiniApp, {plugins});
        }

        // Clear react packager cache beforehand to avoid surprises ...
        clearReactPackagerCache();

        await spin(`Bundling miniapp(s)`, reactNativeBundle(paths));

        log.info(`[=== Completed mini apps bundling ===]`);
    } catch (e) {
        log.error("[bundleMiniApps] Something went wrong: " + e);
    }
}

async function buildAndPublishContainer(paths) {
    try {
        log.info(`[=== Starting build and publication of the container ===]`);

        shell.cd(`${paths.outFolder}`)
        await spin(`Building container and publishing archive`,
            buildAndUploadArchive('lib'));

        log.info(`[=== Completed build and publication of the container ===]`);
    } catch (e) {
        log.error("[buildAndPublishContainer] Something went wrong: " + e);
    }
}

function buildPluginListSync(plugins, manifest) {
    let result = [];

    const manifestPlugins = _.map(
        manifest.supportedPlugins, d => ({
            name: npmModuleRe.exec(d)[1],
            version: npmModuleRe.exec(d)[2]
        }));

    const pluginNames = _.map(plugins, p => {
        return p.scope ?
            `@${p.scope}/${p.name}` :
            p.name;
    });

    for (const manifestPlugin of manifestPlugins) {
        if (pluginNames.includes(manifestPlugin.name)) {
            result.push(manifestPlugin);
        }
    }
    return result;
}

function getReactNativeVersionFromManifest(manifest) {
    const rnDep = _.find(manifest.supportedPlugins, d => d.startsWith('react-native@'));
    return npmModuleRe.exec(rnDep)[2];
}

async function isArtifactInMavenRepo(artifactDescriptor, mavenRepoUrl) {
    // An artifact follows the format group:name:version
    // i.e com.walmartlabs.ern:react-native-electrode-bridge:1.0.0
    // Split it !
    const explodedArtifactDescriptor = artifactDescriptor.split(':');
    // We replace all '.' in the group with `/`
    // i.e: com.walmartlabs.ern => com/walmartlabs/ern
    // As it corresponds to the path where artifact is stored
    explodedArtifactDescriptor[0] = explodedArtifactDescriptor[0].replace(/[.]/g, '/');
    // And we join everything together to get full path in the repository
    // i.e: com.walmartlabs.ern:react-native-electrode-bridge:1.0.0
    // => com/walmartlabs/ern/react-native-electrode-bridge/1.0.0
    const pathToArtifactInRepository = explodedArtifactDescriptor.join('/');
    const mavenRepositoryType = getMavenRepositoryType(mavenRepoUrl);

    // Remote maven repo
    // Just do an HTTP GET to the url of the artifact.
    // If it returns '200' status code, it means the artifact exists, otherwise
    // it doesn't
    if (mavenRepositoryType === 'http') {
        // Last `/` is important here, otherwise we'll get an HTTP 302 instead of 200
        // in case the artifact does exists !
        const res = await httpGet(`${mavenRepoUrl}/${pathToArtifactInRepository}/`);
        return res.statusCode === 200;
    }
    // Otherwise if local storage just check if folder exists !
    else if (mavenRepositoryType === 'file') {
        const mavenRepositoryPath = mavenRepoUrl.replace('file://', '');
        const exists = fs.existsSync(`${mavenRepositoryPath}/${pathToArtifactInRepository}`);
        return fs.existsSync(`${mavenRepositoryPath}/${pathToArtifactInRepository}`);
    }
}

function getMavenRepositoryType(mavenRepoUrl) {
    if (mavenRepoUrl.startsWith('http')) {
        return 'http';
    } else if (mavenRepoUrl.startsWith('file')) {
        return 'file';
    }
    return 'invalid';
}

//=============================================================================
// ern-container-gen android generation
//=============================================================================

async function generateAndroidContainer(nativeAppName = required('nativeAppName'),
                                        platformPath = required('platformPath'),
                                        generator = required('generator'),
                                        plugins = [],
                                        miniapps = []) {
    if (generator.name === 'maven') {
        return generateAndroidContainerUsingMavenGenerator(
            nativeAppName, platformPath, plugins, miniapps, generator);
    } else {
        throw new Error(`Android generator ${generator.name} not supported`);
    }
}

async function generateAndroidContainerUsingMavenGenerator(nativeAppName = required('nativeAppName'),
                                                           platformPath = required('platformPath'),
                                                           plugins = [],
                                                           miniapps = [], {
        containerPomVersion,
        mavenRepositoryUrl = DEFAULT_MAVEN_REPO_URL,
        namespace = DEFAULT_NAMESPACE
    } = {}) {
    // Folder from which container gen is run from
    const WORKING_FOLDER = `${ERN_PATH}/containergen`;
    // Folder from which we download all plugins sources (from npm or git)
    const TMP_FOLDER = `${WORKING_FOLDER}/.tmp`;
    // Folder where the resulting container project is stored in
    const OUT_FOLDER = `${WORKING_FOLDER}/out`;
    // Folder from which we assemble the miniapps together / run the bundling
    const COMPOSITE_MINIAPP_FOLDER = `${WORKING_FOLDER}/CompositeMiniApp`;

    // If not maven repository url is provided part of the generator config,
    // we just default to standard maven local repository location
    // If folder does not exists yet, we create it
    if ((mavenRepositoryUrl === DEFAULT_MAVEN_REPO_URL)
        && (!fs.existsSync(DEFAULT_MAVEN_REPO_URL))) {
        shell.mkdir('-p', DEFAULT_MAVEN_REPO_URL.replace(fileRe, ''));
    }

    try {
        log.info(`\n === Using maven generator
            mavenRepositoryUrl: ${mavenRepositoryUrl}
            containerPomVersion: ${containerPomVersion}
            namespace: ${namespace}`);

        // Clean up to start fresh
        shell.rm('-rf', TMP_FOLDER);
        shell.rm('-rf', OUT_FOLDER);
        shell.rm('-rf', COMPOSITE_MINIAPP_FOLDER);
        shell.mkdir('-p', TMP_FOLDER);

        // Contains all interesting folders pathes
        const paths = {
            // Where the container project hull is stored
            containerHull: `${platformPath}/ern-container-gen/hull`,
            // Where the container generation configuration of all plugins is stored
            containerPluginsConfig: `${platformPath}/ern-container-gen/plugins`,
            // Where the templates to be used during container generation are stored
            containerTemplates: `${platformPath}/ern-container-gen/templates`,
            // Where we assemble the miniapps together
            compositeMiniApp: COMPOSITE_MINIAPP_FOLDER,
            // Where we download plugins
            tmpFolder: TMP_FOLDER,
            // Where we output final generated container
            outFolder: OUT_FOLDER
        };

        const manifest = require(`${platformPath}/manifest.json`);

        // Build the list of plugins to be included in container
        const includedPlugins = buildPluginListSync(plugins, manifest);
        // Get the react native version to use, based on what is declared on manifest
        // for this current platform version
        const reactNativeVersion = getReactNativeVersionFromManifest(manifest);
        // Get maven repository type (file (mavenLocal) or remote url (Nexus repo or other))
        const mavenRepositoryType = getMavenRepositoryType(mavenRepositoryUrl);

        // Build repository statement to be injected in Android build.gradle for
        // publication target of generated container
        let gradleMavenRepositoryCode;
        if (mavenRepositoryType === 'file') {
            gradleMavenRepositoryCode = `repository(url: "${mavenRepositoryUrl}")`;
        } else if (mavenRepositoryType === 'http') {
            gradleMavenRepositoryCode =
                `repository(url: "${mavenRepositoryUrl}")
       { authentication(userName: mavenUser, password: mavenPassword) }`;
        }

        let exMiniApps = _.map(miniapps, miniapp => ({
            name: miniapp.name,
            unscopedName: getUnscopedModuleName(miniapp.name),
            pascalCaseName: capitalizeFirstLetter(getUnscopedModuleName(miniapp.name)),
            version: miniapp.version
        }));

        // Build our mustache view
        mustacheView = {
            "repository": gradleMavenRepositoryCode,
            mavenRepositoryUrl,
            namespace,
            reactNativeVersion,
            ernPlatformVersion: manifest.platformVersion,
            containerPomVersion,
            nativeAppName,
            miniApps: exMiniApps
        }

        // Let's make sure that react-native is included (otherwise there is
        // something pretty much wrong)
        const reactNativePlugin = _.find(plugins, p => p.name === 'react-native');
        if (!reactNativePlugin) {
            throw new Error("react-native was not found in plugins list !");
        }

        //
        // Go through all ern-container-gen steps

        // Copy the container hull to output folder and patch it
        // - Retrieves (download) each plugin from npm or git and inject
        //   plugin source in container
        // - Inject configuration code for plugins that expose configuration
        // - Create activities for MiniApps
        // - Patch build.gradle for versioning of the container project and
        //   to specify publication repository target
        await fillContainerHull(includedPlugins, miniapps, paths);

        // Bundle all the miniapps together and store resulting bundle in container
        // project
        await bundleMiniApps(miniapps, paths, includedPlugins);

        // Finally, container hull project is fully generated, now let's just
        // build it and publish resulting AAR
        await buildAndPublishContainer(paths);

        log.info(`Published com.walmartlabs.ern:${nativeAppName}-ern-container:${containerPomVersion}`);
        log.info(`To ${mavenRepositoryUrl}`);
    } catch (e) {
        log.error(`Something went wrong. Aborting ern-container-gen: ${e}`);
    }
}

//=============================================================================
// ern-container-gen ios generation
//=============================================================================

async function generateIosContainer(nativeAppName = required('nativeAppName'),
                                    platformPath = required('platformPath'),
                                    generator = required('generator'),
                                    plugins = [],
                                    miniapps = []) {
    throw new Error(`No iOS generator yet`);
}

//=============================================================================
// ern-container-gen entry point
//=============================================================================

function required(param) {
    throw new Error(`Missing required ${param} parameter`);
}

// generator: The generator to use along with its config
//  ex :
//  {
//    platform: "android",
//    name: "maven",
//    containerPomVersion: "1.2.3",
//    mavenRepositoryUrl = ...
//  }
// plugins: Array containing all plugins to be included in the container
//  ex :
//  [{ name: "react-native", version: "0.40.0"}, {name: "react-native-code-push"}]
// miniApps: Array of mini apps to be included in the container
//  ex :
//  [
//    {
//      name: "RnDemoApp",
//      version: "1.0.0"
//    }
//  ]
export async function generateContainer({
    nativeAppName = required('nativeAppName'),
    platformPath = required('platformPath'),
    generator = required('generator'),
    plugins = [],
    miniapps = [],
    verbose = false
} = {}) {
    try {
        log = require('console-log-level')({
            prefix: () => '[ern-container-gen]',
            level: verbose ? 'info' : 'warn'
        });

        if (generator.platform === 'android') {
            await generateAndroidContainer(
                nativeAppName,
                platformPath,
                generator,
                plugins,
                miniapps);
        } else if (generator.platform === 'ios') {
            await generateIosContainer(
                nativeAppName,
                platformPath,
                generator,
                plugins,
                miniapps);
        } else {
            throw new Error(`Platform ${generator.platform} not supported`);
        }
    } catch (e) {
        log.error(`Something went wrong. Aborting ern-container-gen: ${e}`);
    }
}