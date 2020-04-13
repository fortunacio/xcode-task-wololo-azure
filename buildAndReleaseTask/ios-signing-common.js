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
/**
 * Creates a temporary keychain and installs the P12 cert in the temporary keychain
 * @param keychainPath the path to the keychain file
 * @param keychainPwd the password to use for unlocking the keychain
 * @param p12CertPath the P12 cert to be installed in the keychain
 * @param p12Pwd the password for the P12 cert
 * @param useKeychainIfExists Pass false to delete and recreate a preexisting keychain
 */
function installCertInTemporaryKeychain(keychainPath, keychainPwd, p12CertPath, p12Pwd, useKeychainIfExists) {
    return __awaiter(this, void 0, void 0, function* () {
        let setupKeychain = true;
        if (useKeychainIfExists && tl.exist(keychainPath)) {
            setupKeychain = false;
        }
        if (setupKeychain) {
            //delete keychain if exists
            yield deleteKeychain(keychainPath);
            //create keychain
            let createKeychainCommand = tl.tool(tl.which('security', true));
            createKeychainCommand.arg(['create-keychain', '-p', keychainPwd, keychainPath]);
            yield createKeychainCommand.exec();
            //update keychain settings, keep keychain unlocked for 6h = 21600 sec, which is the job timeout for paid hosted VMs
            let keychainSettingsCommand = tl.tool(tl.which('security', true));
            keychainSettingsCommand.arg(['set-keychain-settings', '-lut', '21600', keychainPath]);
            yield keychainSettingsCommand.exec();
        }
        //unlock keychain
        yield unlockKeychain(keychainPath, keychainPwd);
        //import p12 cert into the keychain
        let importP12Command = tl.tool(tl.which('security', true));
        if (!p12Pwd) {
            // if password is null or not defined, set it to empty
            p12Pwd = '';
        }
        importP12Command.arg(['import', p12CertPath, '-P', p12Pwd, '-A', '-t', 'cert', '-f', 'pkcs12', '-k', keychainPath]);
        yield importP12Command.exec();
        //If we imported into a pre-existing keychain (e.g. login.keychain), set the partition_id ACL for the private key we just imported
        //so codesign won't prompt to use the key for signing. This isn't necessary for temporary keychains, at least on High Sierra.
        //See https://stackoverflow.com/questions/39868578/security-codesign-in-sierra-keychain-ignores-access-control-settings-and-ui-p
        if (!setupKeychain) {
            const privateKeyName = yield getP12PrivateKeyName(p12CertPath, p12Pwd);
            yield setKeyPartitionList(keychainPath, keychainPwd, privateKeyName);
        }
        //list the keychains to get current keychains in search path
        let listAllOutput;
        let listAllCommand = tl.tool(tl.which('security', true));
        listAllCommand.arg(['list-keychain', '-d', 'user']);
        listAllCommand.on('stdout', function (data) {
            if (data) {
                if (listAllOutput) {
                    listAllOutput = listAllOutput.concat(data.toString().trim());
                }
                else {
                    listAllOutput = data.toString().trim();
                }
            }
        });
        yield listAllCommand.exec();
        let allKeychainsArr = [];
        tl.debug('listAllOutput = ' + listAllOutput);
        //parse out all the existing keychains in search path
        if (listAllOutput) {
            allKeychainsArr = listAllOutput.split(/[\n\r\f\v]/gm);
        }
        //add the keychain to list path along with existing keychains if it is not in the path
        if (listAllOutput && listAllOutput.indexOf(keychainPath) < 0) {
            let listAddCommand = tl.tool(tl.which('security', true));
            listAddCommand.arg(['list-keychain', '-d', 'user', '-s', keychainPath]);
            for (var i = 0; i < allKeychainsArr.length; i++) {
                listAddCommand.arg(allKeychainsArr[i].trim().replace(/"/gm, ''));
            }
            yield listAddCommand.exec();
        }
        let listVerifyOutput;
        let listVerifyCommand = tl.tool(tl.which('security', true));
        listVerifyCommand.arg(['list-keychain', '-d', 'user']);
        listVerifyCommand.on('stdout', function (data) {
            if (data) {
                if (listVerifyOutput) {
                    listVerifyOutput = listVerifyOutput.concat(data.toString().trim());
                }
                else {
                    listVerifyOutput = data.toString().trim();
                }
            }
        });
        yield listVerifyCommand.exec();
        if (!listVerifyOutput || listVerifyOutput.indexOf(keychainPath) < 0) {
            throw tl.loc('TempKeychainSetupFailed');
        }
    });
}
exports.installCertInTemporaryKeychain = installCertInTemporaryKeychain;
/**
 * Finds an iOS codesigning identity in the specified keychain
 * @param keychainPath
 * @returns {string} signing identity found
 */
function findSigningIdentity(keychainPath) {
    return __awaiter(this, void 0, void 0, function* () {
        let signIdentity;
        let findIdentityCmd = tl.tool(tl.which('security', true));
        findIdentityCmd.arg(['find-identity', '-v', '-p', 'codesigning', keychainPath]);
        findIdentityCmd.on('stdout', function (data) {
            if (data) {
                let matches = data.toString().trim().match(/"(.+)"/g);
                tl.debug('signing identity data = ' + matches);
                if (matches && matches[0]) {
                    signIdentity = matches[0].replace(/"/gm, '');
                    tl.debug('signing identity data trimmed = ' + signIdentity);
                }
            }
        });
        yield findIdentityCmd.exec();
        if (signIdentity) {
            tl.debug('findSigningIdentity = ' + signIdentity);
            return signIdentity;
        }
        else {
            throw tl.loc('SignIdNotFound');
        }
    });
}
exports.findSigningIdentity = findSigningIdentity;
/**
 * Get Cloud entitlement type Production or Development according to the export method - if entitlement doesn't exists in provisioning profile returns null
 * @param provisioningProfilePath
 * @param exportMethod
 * @returns {string}
 */
function getCloudEntitlement(provisioningProfilePath, exportMethod) {
    return __awaiter(this, void 0, void 0, function* () {
        //find the provisioning profile details
        let provProfileDetails;
        const getProvProfileDetailsCmd = tl.tool(tl.which('security', true));
        getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provisioningProfilePath]);
        getProvProfileDetailsCmd.on('stdout', function (data) {
            if (data) {
                if (provProfileDetails) {
                    provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
                }
                else {
                    provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
                }
            }
        });
        yield getProvProfileDetailsCmd.exec();
        let tmpPlist;
        if (provProfileDetails) {
            //write the provisioning profile to a plist
            tmpPlist = '_xcodetasktmp.plist';
            tl.writeFile(tmpPlist, provProfileDetails);
        }
        else {
            throw tl.loc('ProvProfileDetailsNotFound', provisioningProfilePath);
        }
        //use PlistBuddy to figure out if cloud entitlement exists.
        const cloudEntitlement = yield printFromPlist('Entitlements:com.apple.developer.icloud-container-environment', tmpPlist);
        //delete the temporary plist file
        const deletePlistCommand = tl.tool(tl.which('rm', true));
        deletePlistCommand.arg(['-f', tmpPlist]);
        yield deletePlistCommand.exec();
        if (!cloudEntitlement) {
            return null;
        }
        tl.debug('Provisioning Profile contains cloud entitlement');
        return (exportMethod === 'app-store' || exportMethod === 'enterprise' || exportMethod === 'developer-id')
            ? "Production"
            : "Development";
    });
}
exports.getCloudEntitlement = getCloudEntitlement;
/**
 * Find the UUID and Name of the provisioning profile and install the profile
 * @param provProfilePath
 * @returns { provProfileUUID, provProfileName }
 */
function installProvisioningProfile(provProfilePath) {
    return __awaiter(this, void 0, void 0, function* () {
        //find the provisioning profile UUID
        let provProfileDetails;
        let getProvProfileDetailsCmd = tl.tool(tl.which('security', true));
        getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
        getProvProfileDetailsCmd.on('stdout', function (data) {
            if (data) {
                if (provProfileDetails) {
                    provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
                }
                else {
                    provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
                }
            }
        });
        yield getProvProfileDetailsCmd.exec();
        let tmpPlist;
        if (provProfileDetails) {
            //write the provisioning profile to a plist
            tmpPlist = '_xcodetasktmp.plist';
            tl.writeFile(tmpPlist, provProfileDetails);
        }
        else {
            throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
        }
        //use PlistBuddy to figure out the UUID
        let provProfileUUID;
        let plist = tl.which('/usr/libexec/PlistBuddy', true);
        let plistTool = tl.tool(plist);
        plistTool.arg(['-c', 'Print UUID', tmpPlist]);
        plistTool.on('stdout', function (data) {
            if (data) {
                provProfileUUID = data.toString().trim();
            }
        });
        yield plistTool.exec();
        //use PlistBuddy to figure out the Name
        let provProfileName;
        plistTool = tl.tool(plist);
        plistTool.arg(['-c', 'Print Name', tmpPlist]);
        plistTool.on('stdout', function (data) {
            if (data) {
                provProfileName = data.toString().trim();
            }
        });
        yield plistTool.exec();
        //delete the temporary plist file
        let deletePlistCommand = tl.tool(tl.which('rm', true));
        deletePlistCommand.arg(['-f', tmpPlist]);
        yield deletePlistCommand.exec();
        if (provProfileUUID) {
            //copy the provisioning profile file to ~/Library/MobileDevice/Provisioning Profiles
            tl.mkdirP(getUserProvisioningProfilesPath()); // Path may not exist if Xcode has not been run yet.
            let pathToProvProfile = getProvisioningProfilePath(provProfileUUID, provProfilePath);
            let copyProvProfileCmd = tl.tool(tl.which('cp', true));
            copyProvProfileCmd.arg(['-f', provProfilePath, pathToProvProfile]);
            yield copyProvProfileCmd.exec();
            if (!provProfileName) {
                tl.warning(tl.loc('ProvProfileNameNotFound'));
            }
            return { provProfileUUID, provProfileName };
        }
        else {
            throw tl.loc('ProvProfileUUIDNotFound', provProfilePath);
        }
    });
}
exports.installProvisioningProfile = installProvisioningProfile;
/**
 * Find the Name of the provisioning profile
 * @param provProfilePath
 * @returns {string} Name
 */
function getProvisioningProfileName(provProfilePath) {
    return __awaiter(this, void 0, void 0, function* () {
        //find the provisioning profile UUID
        let provProfileDetails;
        let getProvProfileDetailsCmd = tl.tool(tl.which('security', true));
        getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
        getProvProfileDetailsCmd.on('stdout', function (data) {
            if (data) {
                if (provProfileDetails) {
                    provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
                }
                else {
                    provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
                }
            }
        });
        yield getProvProfileDetailsCmd.exec();
        let tmpPlist;
        if (provProfileDetails) {
            //write the provisioning profile to a plist
            tmpPlist = '_xcodetasktmp.plist';
            tl.writeFile(tmpPlist, provProfileDetails);
        }
        else {
            throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
        }
        //use PlistBuddy to figure out the Name
        let provProfileName = yield printFromPlist('Name', tmpPlist);
        //delete the temporary plist file
        let deletePlistCommand = tl.tool(tl.which('rm', true));
        deletePlistCommand.arg(['-f', tmpPlist]);
        yield deletePlistCommand.exec();
        tl.debug('getProvisioningProfileName: profile name = ' + provProfileName);
        return provProfileName;
    });
}
exports.getProvisioningProfileName = getProvisioningProfileName;
/**
 * Find the type of the iOS provisioning profile - app-store, ad-hoc, enterprise or development
 * @param provProfilePath
 * @returns {string} type
 */
function getiOSProvisioningProfileType(provProfilePath) {
    return __awaiter(this, void 0, void 0, function* () {
        let provProfileType;
        try {
            //find the provisioning profile details
            let provProfileDetails;
            let getProvProfileDetailsCmd = tl.tool(tl.which('security', true));
            getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
            getProvProfileDetailsCmd.on('stdout', function (data) {
                if (data) {
                    if (provProfileDetails) {
                        provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
                    }
                    else {
                        provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
                    }
                }
            });
            yield getProvProfileDetailsCmd.exec();
            let tmpPlist;
            if (provProfileDetails) {
                //write the provisioning profile to a plist
                tmpPlist = '_xcodetasktmp.plist';
                tl.writeFile(tmpPlist, provProfileDetails);
            }
            else {
                throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
            }
            //get ProvisionsAllDevices - this will exist for enterprise profiles
            let provisionsAllDevices = yield printFromPlist('ProvisionsAllDevices', tmpPlist);
            tl.debug('provisionsAllDevices = ' + provisionsAllDevices);
            if (provisionsAllDevices && provisionsAllDevices.trim().toLowerCase() === 'true') {
                //ProvisionsAllDevices = true in enterprise profiles
                provProfileType = 'enterprise';
            }
            else {
                let getTaskAllow = yield printFromPlist('Entitlements:get-task-allow', tmpPlist);
                tl.debug('getTaskAllow = ' + getTaskAllow);
                if (getTaskAllow && getTaskAllow.trim().toLowerCase() === 'true') {
                    //get-task-allow = true means it is a development profile
                    provProfileType = 'development';
                }
                else {
                    let provisionedDevices = yield printFromPlist('ProvisionedDevices', tmpPlist);
                    if (!provisionedDevices) {
                        // no provisioned devices for non-development profile means it is an app-store profile
                        provProfileType = 'app-store';
                    }
                    else {
                        // non-development profile with provisioned devices - use ad-hoc
                        provProfileType = 'ad-hoc';
                    }
                }
            }
            //delete the temporary plist file
            let deletePlistCommand = tl.tool(tl.which('rm', true));
            deletePlistCommand.arg(['-f', tmpPlist]);
            yield deletePlistCommand.exec();
        }
        catch (err) {
            tl.debug(err);
        }
        return provProfileType;
    });
}
exports.getiOSProvisioningProfileType = getiOSProvisioningProfileType;
/**
 * Find the type of the macOS provisioning profile - app-store, developer-id or development.
 * mac-application is a fourth macOS export method, but it doesn't include signing.
 * @param provProfilePath
 * @returns {string} type
 */
function getmacOSProvisioningProfileType(provProfilePath) {
    return __awaiter(this, void 0, void 0, function* () {
        let provProfileType;
        try {
            //find the provisioning profile details
            let provProfileDetails;
            let getProvProfileDetailsCmd = tl.tool(tl.which('security', true));
            getProvProfileDetailsCmd.arg(['cms', '-D', '-i', provProfilePath]);
            getProvProfileDetailsCmd.on('stdout', function (data) {
                if (data) {
                    if (provProfileDetails) {
                        provProfileDetails = provProfileDetails.concat(data.toString().trim().replace(/[,\n\r\f\v]/gm, ''));
                    }
                    else {
                        provProfileDetails = data.toString().trim().replace(/[,\n\r\f\v]/gm, '');
                    }
                }
            });
            yield getProvProfileDetailsCmd.exec();
            let tmpPlist;
            if (provProfileDetails) {
                //write the provisioning profile to a plist
                tmpPlist = '_xcodetasktmp.plist';
                tl.writeFile(tmpPlist, provProfileDetails);
            }
            else {
                throw tl.loc('ProvProfileDetailsNotFound', provProfilePath);
            }
            //get ProvisionsAllDevices - this will exist for developer-id profiles
            let provisionsAllDevices = yield printFromPlist('ProvisionsAllDevices', tmpPlist);
            tl.debug('provisionsAllDevices = ' + provisionsAllDevices);
            if (provisionsAllDevices && provisionsAllDevices.trim().toLowerCase() === 'true') {
                //ProvisionsAllDevices = true in developer-id profiles
                provProfileType = 'developer-id';
            }
            else {
                let provisionedDevices = yield printFromPlist('ProvisionedDevices', tmpPlist);
                if (!provisionedDevices) {
                    // no provisioned devices means it is an app-store profile
                    provProfileType = 'app-store';
                }
                else {
                    // profile with provisioned devices - use development
                    provProfileType = 'development';
                }
            }
            //delete the temporary plist file
            let deletePlistCommand = tl.tool(tl.which('rm', true));
            deletePlistCommand.arg(['-f', tmpPlist]);
            yield deletePlistCommand.exec();
        }
        catch (err) {
            tl.debug(err);
        }
        return provProfileType;
    });
}
exports.getmacOSProvisioningProfileType = getmacOSProvisioningProfileType;
/**
 * Find the bundle identifier in the specified Info.plist
 * @param plistPath
 * @returns {string} bundle identifier
 */
function getBundleIdFromPlist(plistPath) {
    return __awaiter(this, void 0, void 0, function* () {
        let bundleId = yield printFromPlist('CFBundleIdentifier', plistPath);
        tl.debug('getBundleIdFromPlist bundleId = ' + bundleId);
        return bundleId;
    });
}
exports.getBundleIdFromPlist = getBundleIdFromPlist;
/**
 * Delete specified iOS keychain
 * @param keychainPath
 */
function deleteKeychain(keychainPath) {
    return __awaiter(this, void 0, void 0, function* () {
        if (tl.exist(keychainPath)) {
            let deleteKeychainCommand = tl.tool(tl.which('security', true));
            deleteKeychainCommand.arg(['delete-keychain', keychainPath]);
            yield deleteKeychainCommand.exec();
        }
    });
}
exports.deleteKeychain = deleteKeychain;
/**
 * Unlock specified iOS keychain
 * @param keychainPath
 * @param keychainPwd
 */
function unlockKeychain(keychainPath, keychainPwd) {
    return __awaiter(this, void 0, void 0, function* () {
        //unlock the keychain
        let unlockCommand = tl.tool(tl.which('security', true));
        unlockCommand.arg(['unlock-keychain', '-p', keychainPwd, keychainPath]);
        yield unlockCommand.exec();
    });
}
exports.unlockKeychain = unlockKeychain;
/**
 * Delete provisioning profile with specified UUID in the user's profiles directory
 * @param uuid
 */
function deleteProvisioningProfile(uuid) {
    return __awaiter(this, void 0, void 0, function* () {
        if (uuid && uuid.trim()) {
            const provProfiles = tl.findMatch(getUserProvisioningProfilesPath(), uuid.trim() + '*');
            if (provProfiles) {
                for (const provProfilePath of provProfiles) {
                    console.log('Deleting provisioning profile: ' + provProfilePath);
                    if (tl.exist(provProfilePath)) {
                        const deleteProfileCommand = tl.tool(tl.which('rm', true));
                        deleteProfileCommand.arg(['-f', provProfilePath]);
                        yield deleteProfileCommand.exec();
                    }
                }
            }
        }
    });
}
exports.deleteProvisioningProfile = deleteProvisioningProfile;
/**
 * Gets the path to the iOS default keychain
 */
function getDefaultKeychainPath() {
    return __awaiter(this, void 0, void 0, function* () {
        let defaultKeychainPath;
        let getKeychainCmd = tl.tool(tl.which('security', true));
        getKeychainCmd.arg('default-keychain');
        getKeychainCmd.on('stdout', function (data) {
            if (data) {
                defaultKeychainPath = data.toString().trim().replace(/[",\n\r\f\v]/gm, '');
            }
        });
        yield getKeychainCmd.exec();
        return defaultKeychainPath;
    });
}
exports.getDefaultKeychainPath = getDefaultKeychainPath;
/**
 * Gets the path to the temporary keychain path used during build or release
 */
function getTempKeychainPath() {
    let keychainName = 'ios_signing_temp.keychain';
    let getTempKeychainPath = tl.resolve(tl.getVariable('Agent.TempDirectory'), keychainName);
    return getTempKeychainPath;
}
exports.getTempKeychainPath = getTempKeychainPath;
/**
 * Get several x509 properties from the certificate in a P12 file.
 * @param p12Path Path to the P12 file
 * @param p12Pwd Password for the P12 file
 */
function getP12Properties(p12Path, p12Pwd) {
    return __awaiter(this, void 0, void 0, function* () {
        //openssl pkcs12 -in <p12Path> -nokeys -passin pass:"<p12Pwd>" | openssl x509 -noout -fingerprint –subject -dates
        let opensslPath = tl.which('openssl', true);
        let openssl1 = tl.tool(opensslPath);
        if (!p12Pwd) {
            // if password is null or not defined, set it to empty
            p12Pwd = '';
        }
        openssl1.arg(['pkcs12', '-in', p12Path, '-nokeys', '-passin', 'pass:' + p12Pwd]);
        let openssl2 = tl.tool(opensslPath);
        openssl2.arg(['x509', '-noout', '-fingerprint', '-subject', '-dates']);
        openssl1.pipeExecOutputToTool(openssl2);
        let fingerprint;
        let commonName;
        let notBefore;
        let notAfter;
        function onLine(line) {
            if (line) {
                const tuple = splitIntoKeyValue(line);
                const key = tuple.key;
                const value = tuple.value;
                if (key === 'SHA1 Fingerprint') {
                    // Example value: "BB:26:83:C6:AA:88:35:DE:36:94:F2:CF:37:0A:D4:60:BB:AE:87:0C"
                    // Remove colons separating each octet.
                    fingerprint = value.replace(/:/g, '').trim();
                }
                else if (key === 'subject') {
                    // Example value1: "/UID=E848ASUQZY/CN=iPhone Developer: Chris Sidi (7RZ3N927YF)/OU=DJ8T2973U7/O=Chris Sidi/C=US"
                    // Example value2: "/UID=E848ASUQZY/CN=iPhone Developer: Chris / Sidi (7RZ3N927YF)/OU=DJ8T2973U7/O=Chris Sidi/C=US"
                    // Example value3: "/UID=E848ASUQZY/OU=DJ8T2973U7/O=Chris Sidi/C=US/CN=iPhone Developer: Chris Sidi (7RZ3N927YF)"
                    // Extract the common name.
                    const matches = value.match(/\/CN=.*?(?=\/[A-Za-z]+=|$)/);
                    if (matches && matches[0]) {
                        commonName = matches[0].trim().replace("/CN=", "");
                    }
                }
                else if (key === 'notBefore') {
                    // Example value: "Nov 13 03:37:42 2018 GMT"
                    notBefore = new Date(value);
                }
                else if (key === 'notAfter') {
                    notAfter = new Date(value);
                }
            }
        }
        // Concat all of stdout to avoid shearing. This can be updated to `openssl1.on('stdline', onLine)` once stdline mocking is available.
        let output = '';
        openssl1.on('stdout', (data) => {
            output = output + data.toString();
        });
        try {
            yield openssl1.exec();
            // process the collected stdout.
            let line;
            for (line of output.split('\n')) {
                onLine(line);
            }
        }
        catch (err) {
            if (!p12Pwd) {
                tl.warning(tl.loc('NoP12PwdWarning'));
            }
            throw err;
        }
        tl.debug(`P12 fingerprint: ${fingerprint}`);
        tl.debug(`P12 common name (CN): ${commonName}`);
        tl.debug(`NotBefore: ${notBefore}`);
        tl.debug(`NotAfter: ${notAfter}`);
        return { fingerprint, commonName, notBefore, notAfter };
    });
}
exports.getP12Properties = getP12Properties;
/**
 * Delete certificate with specified SHA1 hash (thumbprint) from a keychain.
 * @param keychainPath
 * @param certSha1Hash
 */
function deleteCert(keychainPath, certSha1Hash) {
    return __awaiter(this, void 0, void 0, function* () {
        let deleteCert = tl.tool(tl.which('security', true));
        deleteCert.arg(['delete-certificate', '-Z', certSha1Hash, keychainPath]);
        yield deleteCert.exec();
    });
}
exports.deleteCert = deleteCert;
/**
 * Get the friendly name from the private key in a P12 file.
 * @param p12Path Path to the P12 file
 * @param p12Pwd Password for the P12 file
 */
function getP12PrivateKeyName(p12Path, p12Pwd) {
    return __awaiter(this, void 0, void 0, function* () {
        //openssl pkcs12 -in <p12Path> -nocerts -passin pass:"<p12Pwd>" -passout pass:"<p12Pwd>" | grep 'friendlyName'
        tl.debug('getting the P12 private key name');
        const opensslPath = tl.which('openssl', true);
        const openssl = tl.tool(opensslPath);
        if (!p12Pwd) {
            // if password is null or not defined, set it to empty
            p12Pwd = '';
        }
        // since we can't suppress the private key bytes, encrypt them before we pass them to grep.
        const privateKeyPassword = p12Pwd ? p12Pwd : generatePassword();
        openssl.arg(['pkcs12', '-in', p12Path, '-nocerts', '-passin', 'pass:' + p12Pwd, '-passout', 'pass:' + privateKeyPassword]);
        //we pipe through grep so we we don't log the private key to the console.
        //even if it's encrypted, it's noise and could cause concern for some users.
        const grepPath = tl.which('grep', true);
        const grep = tl.tool(grepPath);
        grep.arg(['friendlyName']);
        openssl.pipeExecOutputToTool(grep);
        let privateKeyName;
        openssl.on('stdout', function (data) {
            if (data) {
                // find the private key name
                data = data.toString().trim();
                const match = data.match(/friendlyName: (.*)/);
                if (match && match[1]) {
                    privateKeyName = match[1].trim();
                }
            }
        });
        yield openssl.exec();
        tl.debug('P12 private key name = ' + privateKeyName);
        if (!privateKeyName) {
            throw new Error(tl.loc('P12PrivateKeyNameNotFound', p12Path));
        }
        return privateKeyName;
    });
}
exports.getP12PrivateKeyName = getP12PrivateKeyName;
function printFromPlist(itemToPrint, plistPath) {
    return __awaiter(this, void 0, void 0, function* () {
        let plist = tl.which('/usr/libexec/PlistBuddy', true);
        let plistTool = tl.tool(plist);
        plistTool.arg(['-c', 'Print ' + itemToPrint, plistPath]);
        let printedValue;
        plistTool.on('stdout', function (data) {
            if (data) {
                printedValue = data.toString().trim();
            }
        });
        try {
            yield plistTool.exec();
        }
        catch (err) {
            tl.debug('Exception when looking for ' + itemToPrint + ' in plist.');
            printedValue = null;
        }
        return printedValue;
    });
}
function getProvisioningProfilePath(uuid, provProfilePath) {
    let profileExtension = '';
    if (provProfilePath) {
        profileExtension = path.extname(provProfilePath);
    }
    return tl.resolve(getUserProvisioningProfilesPath(), uuid.trim().concat(profileExtension));
}
/**
 * Set the partition_id ACL so codesign has permission to use the signing key.
 */
function setKeyPartitionList(keychainPath, keychainPwd, privateKeyName) {
    return __awaiter(this, void 0, void 0, function* () {
        // security set-key-partition-list -S apple-tool:,apple: -s -l <privateKeyName> -k <keychainPwd> <keychainPath>
        // n.b. This command could update multiple keys (e.g. an expired signing key and a newer signing key.)
        if (privateKeyName) {
            tl.debug(`Setting the partition_id ACL for ${privateKeyName}`);
            // "If you'd like to run /usr/bin/codesign with the key, "apple:" must be an element of the partition list." - security(1) man page.
            // When you sign into your developer account in Xcode on a new machine, you get a private key with partition list "apple:". However
            // "security import a.p12 -k login.keychain" results in the private key with partition list "apple-tool:". I'm preserving import's
            // "apple-tool:" and adding the "apple:" codesign needs.
            const partitionList = 'apple-tool:,apple:';
            let setKeyCommand = tl.tool(tl.which('security', true));
            setKeyCommand.arg(['set-key-partition-list', '-S', partitionList, '-s', '-l', privateKeyName, '-k', keychainPwd, keychainPath]);
            // Watch for "unknown command". set-key-partition-list was added in Sierra (macOS v10.12)
            let unknownCommandErrorFound;
            let incorrectPasswordErrorFound;
            setKeyCommand.on('errline', (line) => {
                if (!unknownCommandErrorFound && line.includes('security: unknown command')) {
                    unknownCommandErrorFound = true;
                }
            });
            try {
                yield setKeyCommand.exec();
            }
            catch (err) {
                if (unknownCommandErrorFound) {
                    // If we're on an older OS, we don't need to run set-key-partition-list.
                    console.log(tl.loc('SetKeyPartitionListCommandNotFound'));
                }
                else {
                    tl.error(err);
                    throw new Error(tl.loc('SetKeyPartitionListCommandFailed'));
                }
            }
        }
    });
}
function generatePassword() {
    return Math.random().toString(36);
}
function getUserProvisioningProfilesPath() {
    return tl.resolve(tl.getVariable('HOME'), 'Library', 'MobileDevice', 'Provisioning Profiles');
}
function splitIntoKeyValue(line) {
    // Don't use `split`. The value may contain `=` (e.g. "/UID=E848ASUQZY/CN=iPhone Developer: ...")
    const index = line.indexOf('=');
    if (index) {
        return { key: line.substring(0, index), value: line.substring(index + 1) };
    }
    else {
        return undefined;
    }
}
