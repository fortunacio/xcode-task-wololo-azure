"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const tl = require("azure-pipelines-task-lib/task");
const readline = require('readline');
const fs = require('fs');
const semver = require("semver");
// These fallback paths are checked if a XCODE_N_DEVELOPER_DIR environment variable is not found.
// Using the environment variable for resolution is preferable to these hardcoded paths.
const fallbackDeveloperDirs = {
    "8": "/Applications/Xcode_8.3.3.app/Contents/Developer",
    "9": "/Applications/Xcode_9.1.app/Contents/Developer"
};
function setTaskState(variableName, variableValue) {
    if (agentSupportsTaskState()) {
        tl.setTaskVariable(variableName, variableValue);
    }
}
exports.setTaskState = setTaskState;
function getTaskState(variableName) {
    if (agentSupportsTaskState()) {
        return tl.getTaskVariable(variableName);
    }
}
exports.getTaskState = getTaskState;
function findDeveloperDir(xcodeVersion) {
    tl.debug(tl.loc('LocateXcodeBasedOnVersion', xcodeVersion));
    // xcodeVersion should be in the form of "8" or "9".
    // envName for version 9.*.* would be "XCODE_9_DEVELOPER_DIR"
    let envName = `XCODE_${xcodeVersion}_DEVELOPER_DIR`;
    let discoveredDeveloperDir = tl.getVariable(envName);
    if (!discoveredDeveloperDir) {
        discoveredDeveloperDir = fallbackDeveloperDirs[xcodeVersion];
        if (discoveredDeveloperDir && !tl.exist(discoveredDeveloperDir)) {
            tl.debug(`Ignoring fallback developer path. ${discoveredDeveloperDir} doesn't exist.`);
            discoveredDeveloperDir = undefined;
        }
        if (!discoveredDeveloperDir) {
            throw new Error(tl.loc('FailedToLocateSpecifiedXcode', xcodeVersion, envName));
        }
    }
    return discoveredDeveloperDir;
}
exports.findDeveloperDir = findDeveloperDir;
function buildDestinationArgs(platform, devices, targetingSimulators) {
    let destinations = [];
    devices.forEach((device) => {
        device = device.trim();
        let destination;
        if (device) {
            if (targetingSimulators) {
                destination = `platform=${platform} Simulator`;
            }
            else {
                destination = `platform=${platform}`;
            }
            // The device name may be followed by additional key-value pairs. Example: "iPhone X,OS=11.1"
            destination += `,name=${device}`;
            tl.debug(`Constructed destination: ${destination}`);
            destinations.push(destination);
        }
    });
    return destinations;
}
exports.buildDestinationArgs = buildDestinationArgs;
/**
 * Queries the schemes in a workspace.
 * @param xcbuild xcodebuild path
 * @param workspace workspace path
 *
 * Testing shows Xcode 9 returns shared schemes only (a good thing).
 */
function getWorkspaceSchemes(xcbuild, workspace) {
    return __awaiter(this, void 0, void 0, function* () {
        let xcv = tl.tool(xcbuild);
        xcv.arg(['-workspace', workspace]);
        xcv.arg('-list');
        let schemes = [];
        let inSchemesSection = false;
        let output = '';
        xcv.on('stdout', (data) => {
            output = output + data.toString();
        });
        yield xcv.exec();
        output.split('\n').forEach((line) => {
            tl.debug(`Line: ${line}`);
            line = line.trim();
            if (inSchemesSection) {
                if (line !== '') {
                    tl.debug(`Scheme: ${line}`);
                    schemes.push(line);
                }
                else {
                    inSchemesSection = false;
                }
            }
            else if (line === 'Schemes:') {
                inSchemesSection = true;
            }
        });
        return schemes;
    });
}
exports.getWorkspaceSchemes = getWorkspaceSchemes;
/**
 * Returns the first provisioning/signing style found in workspace's project files: "auto", "manual" or undefined if not found.
 */
function getProvisioningStyle(workspace) {
    return __awaiter(this, void 0, void 0, function* () {
        let provisioningStyle;
        if (workspace) {
            let pbxProjectPath = getPbxProjectPath(workspace);
            tl.debug(`pbxProjectPath is ${pbxProjectPath}`);
            if (pbxProjectPath) {
                provisioningStyle = yield getProvisioningStyleFromPbxProject(pbxProjectPath);
                tl.debug(`pbxProjectPath provisioning style: ${provisioningStyle}`);
            }
        }
        return provisioningStyle;
    });
}
exports.getProvisioningStyle = getProvisioningStyle;
function getPbxProjectPath(workspace) {
    if (workspace && workspace.trim().toLowerCase().endsWith('.xcworkspace')) {
        let pbxProjectPath = workspace.trim().toLowerCase().replace('.xcworkspace', '.pbxproj');
        if (pathExistsAsFile(pbxProjectPath)) {
            return pbxProjectPath;
        }
        else {
            tl.debug("Corresponding pbxProject file doesn't exist: " + pbxProjectPath);
        }
    }
}
function getProvisioningStyleFromPbxProject(pbxProjectPath) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: fs.createReadStream(pbxProjectPath)
        });
        let firstProvisioningStyleFound = false;
        let linesExamined = 0;
        rl.on('line', (line) => {
            if (!firstProvisioningStyleFound) {
                linesExamined++;
                let trimmedLine = line.trim();
                if (trimmedLine === 'ProvisioningStyle = Automatic;') {
                    tl.debug(`first provisioning style line: ${line}`);
                    firstProvisioningStyleFound = true;
                    resolve("auto");
                }
                else if (trimmedLine === 'ProvisioningStyle = Manual;') {
                    tl.debug(`first provisioning style line: ${line}`);
                    firstProvisioningStyleFound = true;
                    resolve("manual");
                }
            }
        }).on('close', () => {
            if (!firstProvisioningStyleFound) {
                tl.debug(`close event occurred before a provisioning style was found in the pbxProject file. Lines examined: ${linesExamined}`);
                resolve(undefined);
            }
        });
    });
}
function pathExistsAsFile(path) {
    try {
        return tl.stats(path).isFile();
    }
    catch (error) {
        return false;
    }
}
exports.pathExistsAsFile = pathExistsAsFile;
function getUniqueLogFileName(logPrefix) {
    //find a unique log file name
    let filePath = tl.resolve(tl.getVariable('Agent.TempDirectory'), logPrefix + '.log');
    let index = 1;
    while (tl.exist(filePath)) {
        filePath = tl.resolve(tl.getVariable('Agent.TempDirectory'), logPrefix + index.toString() + '.log');
        index++;
    }
    return filePath;
}
exports.getUniqueLogFileName = getUniqueLogFileName;
function uploadLogFile(logFile) {
    if (tl.exist(logFile)) {
        console.log(`##vso[task.uploadfile]${logFile}`);
    }
}
exports.uploadLogFile = uploadLogFile;
// Same signature and behavior as utility-common/telemetry's emitTelemetry, minus the common vars.
function emitTelemetry(area, feature, taskSpecificTelemetry) {
    try {
        let agentVersion = tl.getVariable('Agent.Version');
        if (semver.gte(agentVersion, '2.120.0')) {
            console.log("##vso[telemetry.publish area=%s;feature=%s]%s", area, feature, JSON.stringify(taskSpecificTelemetry));
        }
        else {
            tl.debug(`Agent version is ${agentVersion}. Version 2.120.0 or higher is needed for telemetry.`);
        }
    }
    catch (err) {
        tl.debug(`Unable to log telemetry. Err:( ${err} )`);
    }
}
exports.emitTelemetry = emitTelemetry;
function agentSupportsTaskState() {
    let agentSupportsTaskState = true;
    try {
        tl.assertAgent('2.115.0');
    }
    catch (e) {
        agentSupportsTaskState = false;
    }
    return agentSupportsTaskState;
}
