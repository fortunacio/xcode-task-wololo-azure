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
const path = require("path");
const tl = require("azure-pipelines-task-lib/task");
const sign = require("./ios-signing-common");
const utils = require("./xcodeutils");
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        const telemetryData = {};
        try {
            tl.setResourcePath(path.join(__dirname, 'task.json'));
            //--------------------------------------------------------
            // Tooling
            //--------------------------------------------------------
            let xcodeVersionSelection = tl.getInput('xcodeVersion', true);
            telemetryData.xcodeVersionSelection = xcodeVersionSelection;
            if (xcodeVersionSelection === 'specifyPath') {
                let devDir = tl.getInput('xcodeDeveloperDir', true);
                tl.setVariable('DEVELOPER_DIR', devDir);
            }
            else if (xcodeVersionSelection !== 'default') {
                // resolve the developer dir for a version like "8" or "9".
                let devDir = utils.findDeveloperDir(xcodeVersionSelection);
                tl.setVariable('DEVELOPER_DIR', devDir);
            }
            let tool = tl.which('xcodebuild', true);
            tl.debug('Tool selected: ' + tool);
            let workingDir = tl.getPathInput('cwd');
            tl.cd(workingDir);
            //--------------------------------------------------------
            // Xcode args
            //--------------------------------------------------------
            let ws = tl.getPathInput('xcWorkspacePath', false, false);
            if (tl.filePathSupplied('xcWorkspacePath')) {
                let workspaceMatches = tl.findMatch(workingDir, ws, { allowBrokenSymbolicLinks: false, followSpecifiedSymbolicLink: false, followSymbolicLinks: false });
                tl.debug("Found " + workspaceMatches.length + ' workspaces matching.');
                if (workspaceMatches.length > 0) {
                    ws = workspaceMatches[0];
                    if (workspaceMatches.length > 1) {
                        tl.warning(tl.loc('MultipleWorkspacesFound', ws));
                    }
                }
                else {
                    throw new Error(tl.loc('WorkspaceDoesNotExist', ws));
                }
            }
            let isProject = false;
            if (ws && ws.trim().toLowerCase().endsWith('.xcodeproj')) {
                isProject = true;
            }
            let scheme = tl.getInput('scheme', false);
            // If we have a workspace argument but no scheme, see if there's
            // single shared scheme we can use.
            if (!scheme && !isProject && ws && tl.filePathSupplied('xcWorkspacePath')) {
                try {
                    let schemes = yield utils.getWorkspaceSchemes(tool, ws);
                    if (schemes.length > 1) {
                        tl.warning(tl.loc('MultipleSchemesFound'));
                    }
                    else if (schemes.length === 0) {
                        tl.warning(tl.loc('NoSchemeFound'));
                    }
                    else {
                        scheme = schemes[0];
                        console.log(tl.loc('SchemeSelected', scheme));
                    }
                }
                catch (err) {
                    tl.warning(tl.loc('FailedToFindScheme'));
                }
            }
            let destinations;
            let platform = tl.getInput('destinationPlatformOption', false);
            if (platform === 'custom') {
                // Read the custom platform from the text input.
                platform = tl.getInput('destinationPlatform', false);
            }
            if (platform === 'macOS') {
                destinations = ['platform=macOS'];
            }
            else if (platform && platform !== 'default') {
                // To be yaml friendly, destinationTypeOption is optional and we default to simulators.
                let destinationType = tl.getInput('destinationTypeOption', false);
                let targetingSimulators = destinationType !== 'devices';
                let devices;
                if (targetingSimulators) {
                    // Only one simulator for now.
                    devices = [tl.getInput('destinationSimulators')];
                }
                else {
                    // Only one device for now.
                    devices = [tl.getInput('destinationDevices')];
                }
                destinations = utils.buildDestinationArgs(platform, devices, targetingSimulators);
            }
            let sdk = tl.getInput('sdk', false);
            let configuration = tl.getInput('configuration', false);
            let useXcpretty = tl.getBoolInput('useXcpretty', false);
            let actions = tl.getDelimitedInput('actions', ' ', true);
            let packageApp = tl.getBoolInput('packageApp', true);
            let args = tl.getInput('args', false);
            telemetryData.actions = actions;
            telemetryData.packageApp = packageApp;
            //--------------------------------------------------------
            // Exec Tools
            //--------------------------------------------------------
            // --- Xcode Version ---
            let xcv = tl.tool(tool);
            xcv.arg('-version');
            let xcodeMajorVersion = 0;
            xcv.on('stdout', (data) => {
                const match = data.toString().trim().match(/Xcode (.+)/g);
                tl.debug('match = ' + match);
                if (match) {
                    const versionString = match.toString().replace('Xcode', '').trim();
                    const majorVersion = parseInt(versionString);
                    tl.debug('majorVersion = ' + majorVersion);
                    telemetryData.xcodeVersion = versionString;
                    if (!isNaN(majorVersion)) {
                        xcodeMajorVersion = majorVersion;
                    }
                }
            });
            yield xcv.exec();
            tl.debug('xcodeMajorVersion = ' + xcodeMajorVersion);
            // --- Xcode build arguments ---
            let xcb = tl.tool(tool);
            xcb.argIf(sdk, ['-sdk', sdk]);
            xcb.argIf(configuration, ['-configuration', configuration]);
            if (ws && tl.filePathSupplied('xcWorkspacePath')) {
                xcb.argIf(isProject, '-project');
                xcb.argIf(!isProject, '-workspace');
                xcb.arg(ws);
            }
            xcb.argIf(scheme, ['-scheme', scheme]);
            // Add a -destination argument for each device and simulator.
            if (destinations) {
                destinations.forEach(destination => {
                    xcb.arg(['-destination', destination]);
                });
            }
            xcb.arg(actions);
            if (args) {
                xcb.line(args);
            }
            //--------------------------------------------------------
            // iOS signing and provisioning
            //--------------------------------------------------------
            let signingOption = tl.getInput('signingOption', true);
            let xcode_codeSigningAllowed;
            let xcode_codeSignStyle;
            let xcode_otherCodeSignFlags;
            let xcode_codeSignIdentity;
            let xcode_provProfile;
            let xcode_provProfileSpecifier;
            let xcode_devTeam;
            telemetryData.signingOption = signingOption;
            if (signingOption === 'nosign') {
                xcode_codeSigningAllowed = 'CODE_SIGNING_ALLOWED=NO';
            }
            else if (signingOption === 'manual') {
                xcode_codeSignStyle = 'CODE_SIGN_STYLE=Manual';
                const signIdentity = tl.getInput('signingIdentity');
                if (signIdentity) {
                    xcode_codeSignIdentity = 'CODE_SIGN_IDENTITY=' + signIdentity;
                }
                let provProfileUUID = tl.getInput('provisioningProfileUuid');
                let provProfileName = tl.getInput('provisioningProfileName');
                if (!provProfileUUID) {
                    provProfileUUID = "";
                }
                if (!provProfileName) {
                    provProfileName = "";
                }
                let provisioningProfileSuffix = tl.getInput('provisioningProfileSuffix');
                // PROVISIONING_PROFILE_SPECIFIER takes predence over PROVISIONING_PROFILE,
                // so it's important to pass it to Xcode even if it's empty. That way Xcode
                // will ignore any specifier in the project file and honor the specifier
                // or uuid we passed on the commandline. If the user wants to use the specifier
                // in the project file, they should choose the "Project Defaults" signing style.
                if (!provisioningProfileSuffix) {
                    xcode_provProfile = `PROVISIONING_PROFILE=${provProfileUUID}`;
                    xcode_provProfileSpecifier = `PROVISIONING_PROFILE_SPECIFIER=${provProfileName}`;
                }
                else {
                    xcode_provProfile = `PROVISIONING_PROFILE_${provisioningProfileSuffix}=${provProfileUUID}`;
                    xcode_provProfileSpecifier = `PROVISIONING_PROFILE_SPECIFIER_${provisioningProfileSuffix}=${provProfileName}`;
                }
            }
            else if (signingOption === 'auto') {
                xcode_codeSignStyle = 'CODE_SIGN_STYLE=Automatic';
                let teamId = tl.getInput('teamId');
                if (teamId) {
                    xcode_devTeam = 'DEVELOPMENT_TEAM=' + teamId;
                }
            }
            xcb.argIf(xcode_codeSigningAllowed, xcode_codeSigningAllowed);
            xcb.argIf(xcode_codeSignStyle, xcode_codeSignStyle);
            xcb.argIf(xcode_codeSignIdentity, xcode_codeSignIdentity);
            xcb.argIf(xcode_provProfile, xcode_provProfile);
            xcb.argIf(xcode_provProfileSpecifier, xcode_provProfileSpecifier);
            xcb.argIf(xcode_devTeam, xcode_devTeam);
            //--- Enable Xcpretty formatting ---
            if (useXcpretty && !tl.which('xcpretty')) {
                // user wants to enable xcpretty but it is not installed, fallback to xcodebuild raw output
                useXcpretty = false;
                tl.warning(tl.loc("XcprettyNotInstalled"));
            }
            if (useXcpretty) {
                let xcPrettyPath = tl.which('xcpretty', true);
                let xcPrettyTool = tl.tool(xcPrettyPath);
                xcPrettyTool.arg(['-r', 'junit', '--no-color']);
                const logFile = utils.getUniqueLogFileName('xcodebuild');
                xcb.pipeExecOutputToTool(xcPrettyTool, logFile);
                utils.setTaskState('XCODEBUILD_LOG', logFile);
            }
            //--- Xcode Build ---
            let buildOnlyDeviceErrorFound;
            xcb.on('errline', (line) => {
                if (!buildOnlyDeviceErrorFound && line.includes('build only device cannot be used to run this target')) {
                    buildOnlyDeviceErrorFound = true;
                }
            });
            try {
                yield xcb.exec();
            }
            catch (err) {
                if (buildOnlyDeviceErrorFound) {
                    // Tell the user they need to change Destination platform to fix this build error.
                    tl.warning(tl.loc('NoDestinationPlatformWarning'));
                }
                throw err;
            }
            //--------------------------------------------------------
            // Package app to generate .ipa
            //--------------------------------------------------------
            if (packageApp && sdk !== 'iphonesimulator') {
                // use xcodebuild to create the app package
                if (!scheme) {
                    throw new Error(tl.loc("SchemeRequiredForArchive"));
                }
                if (!ws || !tl.filePathSupplied('xcWorkspacePath')) {
                    throw new Error(tl.loc("WorkspaceOrProjectRequiredForArchive"));
                }
                // create archive
                let xcodeArchive = tl.tool(tl.which('xcodebuild', true));
                if (ws && tl.filePathSupplied('xcWorkspacePath')) {
                    xcodeArchive.argIf(isProject, '-project');
                    xcodeArchive.argIf(!isProject, '-workspace');
                    xcodeArchive.arg(ws);
                }
                xcodeArchive.argIf(scheme, ['-scheme', scheme]);
                xcodeArchive.arg('archive'); //archive action
                xcodeArchive.argIf(sdk, ['-sdk', sdk]);
                xcodeArchive.argIf(configuration, ['-configuration', configuration]);
                let archivePath = tl.getInput('archivePath');
                let archiveFolderRoot;
                if (!archivePath.endsWith('.xcarchive')) {
                    archiveFolderRoot = archivePath;
                    archivePath = tl.resolve(archivePath, scheme);
                }
                else {
                    //user specified a file path for archivePath
                    archiveFolderRoot = path.dirname(archivePath);
                }
                xcodeArchive.arg(['-archivePath', archivePath]);
                xcodeArchive.argIf(xcode_otherCodeSignFlags, xcode_otherCodeSignFlags);
                xcodeArchive.argIf(xcode_codeSigningAllowed, xcode_codeSigningAllowed);
                xcodeArchive.argIf(xcode_codeSignStyle, xcode_codeSignStyle);
                xcodeArchive.argIf(xcode_codeSignIdentity, xcode_codeSignIdentity);
                xcodeArchive.argIf(xcode_provProfile, xcode_provProfile);
                xcodeArchive.argIf(xcode_provProfileSpecifier, xcode_provProfileSpecifier);
                xcodeArchive.argIf(xcode_devTeam, xcode_devTeam);
                if (args) {
                    xcodeArchive.line(args);
                }
                if (useXcpretty) {
                    let xcPrettyTool = tl.tool(tl.which('xcpretty', true));
                    xcPrettyTool.arg('--no-color');
                    const logFile = utils.getUniqueLogFileName('xcodebuild_archive');
                    xcodeArchive.pipeExecOutputToTool(xcPrettyTool, logFile);
                    utils.setTaskState('XCODEBUILD_ARCHIVE_LOG', logFile);
                }
                yield xcodeArchive.exec();
                let archiveFolders = tl.findMatch(archiveFolderRoot, '**/*.xcarchive', { allowBrokenSymbolicLinks: false, followSpecifiedSymbolicLink: false, followSymbolicLinks: false });
                if (archiveFolders && archiveFolders.length > 0) {
                    tl.debug(archiveFolders.length + ' archives found for exporting.');
                    //export options plist
                    let exportOptions = tl.getInput('exportOptions');
                    let exportMethod;
                    let exportTeamId;
                    let exportOptionsPlist;
                    let archiveToCheck = archiveFolders[0];
                    let macOSEmbeddedProfilesFound;
                    telemetryData.exportOptions = exportOptions;
                    // iOS provisioning profiles use the .mobileprovision suffix. macOS profiles have the .provisionprofile suffix.
                    let embeddedProvProfiles = tl.findMatch(archiveToCheck, '**/embedded.mobileprovision', { allowBrokenSymbolicLinks: false, followSpecifiedSymbolicLink: false, followSymbolicLinks: false });
                    if (embeddedProvProfiles && embeddedProvProfiles.length > 0) {
                        tl.debug(`${embeddedProvProfiles.length} iOS embedded.mobileprovision file(s) found.`);
                    }
                    else {
                        embeddedProvProfiles = tl.findMatch(archiveToCheck, '**/embedded.provisionprofile', { allowBrokenSymbolicLinks: false, followSpecifiedSymbolicLink: false, followSymbolicLinks: false });
                        if (embeddedProvProfiles && embeddedProvProfiles.length > 0) {
                            tl.debug(`${embeddedProvProfiles.length} macOS embedded.provisionprofile file(s) found.`);
                            macOSEmbeddedProfilesFound = true;
                        }
                    }
                    if (exportOptions === 'auto') {
                        // Automatically try to detect the export-method to use from the provisioning profile
                        // embedded in the .xcarchive file
                        if (embeddedProvProfiles && embeddedProvProfiles.length > 0) {
                            tl.debug('embedded prov profile = ' + embeddedProvProfiles[0]);
                            if (macOSEmbeddedProfilesFound) {
                                exportMethod = yield sign.getmacOSProvisioningProfileType(embeddedProvProfiles[0]);
                            }
                            else {
                                exportMethod = yield sign.getiOSProvisioningProfileType(embeddedProvProfiles[0]);
                            }
                            tl.debug('Using export method = ' + exportMethod);
                        }
                        // If you create a simple macOS app with automatic signing and no entitlements, it won't have an embedded profile.
                        // And export for that app will work with an empty exportOptionsPlist.
                        if (!exportMethod && sdk && sdk !== 'macosx') {
                            tl.warning(tl.loc('ExportMethodNotIdentified'));
                        }
                    }
                    else if (exportOptions === 'specify') {
                        exportMethod = tl.getInput('exportMethod', true);
                        exportTeamId = tl.getInput('exportTeamId');
                    }
                    else if (exportOptions === 'plist') {
                        exportOptionsPlist = tl.getInput('exportOptionsPlist');
                        if (!tl.filePathSupplied('exportOptionsPlist') || !utils.pathExistsAsFile(exportOptionsPlist)) {
                            throw new Error(tl.loc('ExportOptionsPlistInvalidFilePath', exportOptionsPlist));
                        }
                    }
                    if (exportOptions !== 'plist') {
                        // As long as the user didn't provide a plist, start with an empty one.
                        // Xcode 7 warns "-exportArchive without -exportOptionsPlist is deprecated"
                        // Xcode 8+ will error if a plist isn't provided.
                        let plist = tl.which('/usr/libexec/PlistBuddy', true);
                        exportOptionsPlist = '_XcodeTaskExportOptions.plist';
                        tl.tool(plist).arg(['-c', 'Clear', exportOptionsPlist]).execSync();
                        // Add the teamId if provided.
                        if (exportTeamId) {
                            tl.tool(plist).arg(['-c', 'Add teamID string ' + exportTeamId, exportOptionsPlist]).execSync();
                        }
                        // Add the export method if provided or determined above.
                        if (exportMethod) {
                            tl.tool(plist).arg(['-c', 'Add method string ' + exportMethod, exportOptionsPlist]).execSync();
                        }
                        // For auto export, conditionally add entitlements, signingStyle and provisioning profiles.
                        if (xcodeMajorVersion >= 9 && exportOptions === 'auto') {
                            // Propagate any iCloud entitlement.
                            if (embeddedProvProfiles && embeddedProvProfiles.length > 0) {
                                const cloudEntitlement = yield sign.getCloudEntitlement(embeddedProvProfiles[0], exportMethod);
                                if (cloudEntitlement) {
                                    tl.debug("Adding cloud entitlement");
                                    tl.tool(plist).arg(['-c', `Add iCloudContainerEnvironment string ${cloudEntitlement}`, exportOptionsPlist]).execSync();
                                }
                            }
                            let signingOptionForExport = signingOption;
                            // If we're using the project defaults, scan the pbxProject file for the type of signing being used.
                            if (signingOptionForExport === 'default') {
                                signingOptionForExport = yield utils.getProvisioningStyle(ws);
                                if (!signingOptionForExport) {
                                    tl.warning(tl.loc('CantDetermineProvisioningStyle'));
                                }
                            }
                            if (signingOptionForExport === 'manual') {
                                // Xcode 9 manual signing, set code sign style = manual
                                tl.tool(plist).arg(['-c', 'Add signingStyle string ' + 'manual', exportOptionsPlist]).execSync();
                                // add provisioning profiles to the exportOptions plist
                                // find bundle Id from Info.plist and prov profile name from the embedded profile in each .app package
                                tl.tool(plist).arg(['-c', 'Add provisioningProfiles dict', exportOptionsPlist]).execSync();
                                for (let i = 0; i < embeddedProvProfiles.length; i++) {
                                    let embeddedProvProfile = embeddedProvProfiles[i];
                                    let profileName = yield sign.getProvisioningProfileName(embeddedProvProfile);
                                    tl.debug('embedded provisioning profile = ' + embeddedProvProfile + ', profile name = ' + profileName);
                                    let embeddedInfoPlist = tl.resolve(path.dirname(embeddedProvProfile), 'Info.plist');
                                    let bundleId = yield sign.getBundleIdFromPlist(embeddedInfoPlist);
                                    tl.debug('embeddedInfoPlist path = ' + embeddedInfoPlist + ', bundle identifier = ' + bundleId);
                                    if (!profileName || !bundleId) {
                                        throw new Error(tl.loc('FailedToGenerateExportOptionsPlist'));
                                    }
                                    tl.tool(plist).arg(['-c', 'Add provisioningProfiles:' + bundleId + ' string ' + profileName, exportOptionsPlist]).execSync();
                                }
                            }
                        }
                    }
                    //export path
                    let exportPath = tl.getInput('exportPath');
                    for (let i = 0; i < archiveFolders.length; i++) {
                        let archive = archiveFolders.pop();
                        //export the archive
                        let xcodeExport = tl.tool(tl.which('xcodebuild', true));
                        xcodeExport.arg(['-exportArchive', '-archivePath', archive]);
                        xcodeExport.arg(['-exportPath', exportPath]);
                        xcodeExport.argIf(exportOptionsPlist, ['-exportOptionsPlist', exportOptionsPlist]);
                        let exportArgs = tl.getInput('exportArgs');
                        xcodeExport.argIf(exportArgs, exportArgs);
                        if (useXcpretty) {
                            let xcPrettyTool = tl.tool(tl.which('xcpretty', true));
                            xcPrettyTool.arg('--no-color');
                            const logFile = utils.getUniqueLogFileName('xcodebuild_export');
                            xcodeExport.pipeExecOutputToTool(xcPrettyTool, logFile);
                            utils.setTaskState('XCODEBUILD_EXPORT_LOG', logFile);
                        }
                        yield xcodeExport.exec();
                    }
                }
            }
            tl.setResult(tl.TaskResult.Succeeded, tl.loc('XcodeSuccess'));
        }
        catch (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        }
        finally {
            // Publish telemetry
            utils.emitTelemetry('TaskHub', 'Xcode', telemetryData);
        }
    });
}
run();
