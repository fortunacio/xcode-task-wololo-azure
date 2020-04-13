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
const os = require("os");
const path = require("path");
const tl = require("azure-pipelines-task-lib/task");
const sign = require("./ios-signing-common");
const utils = require("./xcodeutils");
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            tl.setResourcePath(path.join(__dirname, 'task.json'));
            // Check platform is macOS since demands are not evaluated on Hosted pools
            if (os.platform() !== 'darwin') {
                console.log(tl.loc('XcodeRequiresMac'));
            }
            else {
                //--------------------------------------------------------
                // Test publishing - publish even if tests fail
                //--------------------------------------------------------
                let testResultsFiles;
                const publishResults = tl.getBoolInput('publishJUnitResults', false);
                const useXcpretty = tl.getBoolInput('useXcpretty', false);
                const workingDir = tl.getPathInput('cwd');
                if (publishResults) {
                    if (!useXcpretty) {
                        throw tl.loc('UseXcprettyForTestPublishing');
                    }
                    else if (useXcpretty && !tl.which('xcpretty')) {
                        throw tl.loc("XcprettyNotInstalled");
                    }
                    else {
                        // xcpretty is enabled and installed
                        testResultsFiles = tl.resolve(workingDir, '**/build/reports/junit.xml');
                        if (testResultsFiles && 0 !== testResultsFiles.length) {
                            //check for pattern in testResultsFiles
                            let matchingTestResultsFiles;
                            if (testResultsFiles.indexOf('*') >= 0) {
                                tl.debug('Pattern found in testResultsFiles parameter');
                                matchingTestResultsFiles = tl.findMatch(workingDir, testResultsFiles, { allowBrokenSymbolicLinks: false, followSpecifiedSymbolicLink: false, followSymbolicLinks: false }, { matchBase: true, nocase: true });
                            }
                            else {
                                tl.debug('No pattern found in testResultsFiles parameter');
                                matchingTestResultsFiles = [testResultsFiles];
                            }
                            if (!matchingTestResultsFiles) {
                                tl.warning(tl.loc('NoTestResultsFound', testResultsFiles));
                            }
                            else {
                                const TESTRUN_SYSTEM = "VSTS - xcode";
                                const tp = new tl.TestPublisher("JUnit");
                                tp.publish(matchingTestResultsFiles, false, "", "", "", true, TESTRUN_SYSTEM);
                            }
                        }
                    }
                }
                //clean up the temporary keychain, so it is not used to search for code signing identity in future builds
                const keychainToDelete = utils.getTaskState('XCODE_KEYCHAIN_TO_DELETE');
                if (keychainToDelete) {
                    try {
                        yield sign.deleteKeychain(keychainToDelete);
                    }
                    catch (err) {
                        tl.debug('Failed to delete temporary keychain. Error = ' + err);
                        tl.warning(tl.loc('TempKeychainDeleteFailed', keychainToDelete));
                    }
                }
                //delete provisioning profile if specified
                const profileToDelete = utils.getTaskState('XCODE_PROFILE_TO_DELETE');
                if (profileToDelete) {
                    try {
                        yield sign.deleteProvisioningProfile(profileToDelete);
                    }
                    catch (err) {
                        tl.debug('Failed to delete provisioning profile. Error = ' + err);
                        tl.warning(tl.loc('ProvProfileDeleteFailed', profileToDelete));
                    }
                }
                //upload detailed logs from xcodebuild if using xcpretty
                utils.uploadLogFile(utils.getTaskState('XCODEBUILD_LOG'));
                utils.uploadLogFile(utils.getTaskState('XCODEBUILD_ARCHIVE_LOG'));
                utils.uploadLogFile(utils.getTaskState('XCODEBUILD_EXPORT_LOG'));
            }
        }
        catch (err) {
            tl.warning(err);
        }
    });
}
run();
