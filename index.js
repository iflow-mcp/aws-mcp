#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAWSCredentialsProvider = void 0;
process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = "1";
const ts_morph_1 = require("ts-morph");
const node_vm_1 = require("node:vm");
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_1 = require("zod");
const AWS = __importStar(require("aws-sdk"));
const open_1 = __importDefault(require("open"));
const credential_providers_1 = require("@aws-sdk/credential-providers");
const codePrompt = `Your job is to answer questions about AWS environment by writing Javascript code using AWS SDK V2. The code must be adhering to a few rules:
- Must be preferring promises over callbacks
- Think step-by-step before writing the code, approach it logically
- MUST written in Javascript (NodeJS) using AWS-SDK V2
- Avoid hardcoded values like ARNs
- Code written should be as parallel as possible enabling the fastest and the most optimal execution
- Code should be handling errors gracefully, especially when doing multiple SDK calls (e.g. when mapping over an array). Each error should be handled and logged with a reason, script should continue to run despite errors
- DO NOT require or import "aws-sdk", it is already available as "AWS" variable
- Access to 3rd party libraries apart from "aws-sdk" is not allowed or possible
- For base64 encoding, use btoa() function instead of Buffer (Buffer is not available in this environment)
- Data returned from AWS-SDK must be returned as JSON containing only the minimal amount of data that is needed to answer the question. All extra data must be filtered out
- Code MUST "return" a value: string, number, boolean or JSON object. If code does not return anything, it will be considered as FAILED
- Whenever tool/function call fails, retry it 3 times before giving up with an improved version of the code based on the returned feedback
- When listing resources, ensure pagination is handled correctly so that all resources are returned
- Do not include any comments in the code
- When doing reduce, don't forget to provide an initial value
- Try to write code that returns as few data as possible to answer without any additional processing required after the code is run
- This tool can ONLY write code that interacts with AWS. It CANNOT generate charts, tables, graphs, etc. Please use artifacts for that instead
Be concise, professional and to the point. Do not give generic advice, always reply with detailed & contextual data sourced from the current AWS environment. Assume user always wants to proceed, do not ask for confirmation. I'll tip you $200 if you do this right.`;
const server = new index_js_1.Server({
    name: "aws-mcp",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
let selectedProfile = null;
let selectedProfileCredentials;
let selectedProfileRegion = "us-east-1";
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "run-aws-code",
                description: "Run AWS code",
                inputSchema: {
                    type: "object",
                    properties: {
                        reasoning: {
                            type: "string",
                            description: "The reasoning behind the code",
                        },
                        code: {
                            type: "string",
                            description: codePrompt,
                        },
                        profileName: {
                            type: "string",
                            description: "Name of the AWS profile to use",
                        },
                        region: {
                            type: "string",
                            description: "Region to use (if not provided, us-east-1 is used)",
                        },
                    },
                    required: ["reasoning", "code"],
                },
            },
            {
                name: "list-credentials",
                description: "List all AWS credentials/configs/profiles that are configured/usable on this machine",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: [],
                },
            },
            {
                name: "select-profile",
                description: "Selects AWS profile to use for subsequent interactions. If needed, does SSO authentication",
                inputSchema: {
                    type: "object",
                    properties: {
                        profile: {
                            type: "string",
                            description: "Name of the AWS profile to select",
                        },
                        region: {
                            type: "string",
                            description: "Region to use (if not provided, us-east-1 is used)",
                        },
                    },
                    required: ["profile"],
                },
            },
        ],
    };
});
const RunAwsCodeSchema = zod_1.z.object({
    reasoning: zod_1.z.string(),
    code: zod_1.z.string(),
    profileName: zod_1.z.string().optional(),
    region: zod_1.z.string().optional(),
});
const SelectProfileSchema = zod_1.z.object({
    profile: zod_1.z.string(),
    region: zod_1.z.string().optional(),
});
// Handle tool execution
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request, c) => {
    const { name, arguments: args } = request.params;
    try {
        const { profiles, error } = await listCredentials();
        if (name === "run-aws-code") {
            const { reasoning, code, profileName, region } = RunAwsCodeSchema.parse(args);
            if (!selectedProfile && !profileName) {
                return createTextResponse(`Please select a profile first using the 'select-profile' tool! Available profiles: ${Object.keys(profiles).join(", ")}`);
            }
            if (profileName) {
                selectedProfileCredentials = await getCredentials(profiles[profileName], profileName, profiles);
                selectedProfile = profileName;
                selectedProfileRegion = region || "us-east-1";
            }
            AWS.config.update({
                region: selectedProfileRegion,
                credentials: selectedProfileCredentials,
            });
            const wrappedCode = wrapUserCode(code);
            const wrappedIIFECode = `(async function() { return (async () => { ${wrappedCode} })(); })()`;
            const result = await (0, node_vm_1.runInContext)(wrappedIIFECode, (0, node_vm_1.createContext)({ AWS }));
            return createTextResponse(JSON.stringify(result));
        }
        else if (name === "list-credentials") {
            return createTextResponse(JSON.stringify({ profiles: Object.keys(profiles), error }));
        }
        else if (name === "select-profile") {
            const { profile, region } = SelectProfileSchema.parse(args);
            const credentials = await getCredentials(profiles[profile], profile, profiles);
            selectedProfile = profile;
            selectedProfileCredentials = credentials;
            selectedProfileRegion = region || "us-east-1";
            return createTextResponse("Authenticated!");
        }
        else {
            throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            throw new Error(`Invalid arguments: ${error.errors
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join(", ")}`);
        }
        throw error;
    }
});
function wrapUserCode(userCode) {
    const project = new ts_morph_1.Project({
        useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile("userCode.ts", userCode);
    const lastStatement = sourceFile.getStatements().pop();
    if (lastStatement &&
        lastStatement.getKind() === ts_morph_1.SyntaxKind.ExpressionStatement) {
        const returnStatement = lastStatement.asKind(ts_morph_1.SyntaxKind.ExpressionStatement);
        if (returnStatement) {
            const expression = returnStatement.getExpression();
            sourceFile.addStatements(`return ${expression.getText()};`);
            returnStatement.remove();
        }
    }
    return sourceFile.getFullText();
}
async function listCredentials() {
    let credentials;
    let configs;
    let error;
    try {
        credentials = new AWS.IniLoader().loadFrom({});
    }
    catch (error) {
        error = `Failed to load credentials: ${error}`;
    }
    try {
        configs = new AWS.IniLoader().loadFrom({ isConfig: true });
    }
    catch (error) {
        error = `Failed to load configs: ${error}`;
    }
    const profiles = { ...(credentials || {}), ...(configs || {}) };
    return { profiles, error };
}
async function getCredentials(creds, profileName, profiles) {
    let ssoStartUrl;
    let ssoRegion;
    if (creds.sso_start_url) {
        ssoStartUrl = creds.sso_start_url;
        ssoRegion = creds.region || "us-east-1";
    }
    else if (creds.sso_session) {
        const ssoSessionName = creds.sso_session;
        const ssoSessionConfig = profiles[ssoSessionName];
        if (!ssoSessionConfig) {
            throw new Error(`SSO session '${ssoSessionName}' not found in configuration`);
        }
        if (!ssoSessionConfig.sso_start_url) {
            throw new Error(`SSO session '${ssoSessionName}' missing sso_start_url`);
        }
        ssoStartUrl = ssoSessionConfig.sso_start_url;
        ssoRegion = ssoSessionConfig.sso_region || creds.region || "us-east-1";
    }
    else {
        return (0, exports.useAWSCredentialsProvider)(profileName);
    }
    const oidc = new AWS.SSOOIDC({ region: ssoRegion });
    const registration = await oidc
        .registerClient({ clientName: "chatwithcloud", clientType: "public" })
        .promise();
    const auth = await oidc
        .startDeviceAuthorization({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        startUrl: ssoStartUrl,
    })
        .promise();
    if (auth.verificationUriComplete) {
        (0, open_1.default)(auth.verificationUriComplete);
    }
    let handleId;
    return new Promise((resolve) => {
        handleId = setInterval(async () => {
            try {
                const createTokenReponse = await oidc
                    .createToken({
                    clientId: registration.clientId,
                    clientSecret: registration.clientSecret,
                    grantType: "urn:ietf:params:oauth:grant-type:device_code",
                    deviceCode: auth.deviceCode,
                })
                    .promise();
                const sso = new AWS.SSO({ region: ssoRegion });
                const credentials = await sso
                    .getRoleCredentials({
                    accessToken: createTokenReponse.accessToken,
                    accountId: creds.sso_account_id,
                    roleName: creds.sso_role_name,
                })
                    .promise();
                clearInterval(handleId);
                return resolve(credentials.roleCredentials);
            }
            catch (error) {
                if (error.message !== null) {
                    // terminal.error(error);
                }
            }
        }, 2500);
    });
}
const useAWSCredentialsProvider = (profileName, region = "us-east-1", roleArn) => {
    const provider = (0, credential_providers_1.fromNodeProviderChain)({
        clientConfig: { region: region },
        profile: profileName,
        roleArn,
        // TODO: use a better MFA provider that works with Claude
        mfaCodeProvider: async (serialArn) => {
            const readline = await Promise.resolve().then(() => __importStar(require("readline")));
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            return new Promise((resolve) => {
                const prompt = () => rl.question(`Enter MFA code for ${serialArn}: `, async (input) => {
                    if (input.trim() !== "") {
                        resolve(input.trim());
                        rl.close();
                    }
                    else {
                        // prompt again if no input
                        prompt();
                    }
                });
                prompt();
            });
        },
    });
    return provider();
};
exports.useAWSCredentialsProvider = useAWSCredentialsProvider;
// Start the server
const transport = new stdio_js_1.StdioServerTransport();
server.connect(transport).then(() => {
    console.error("Local Machine MCP Server running on stdio");
});
const createTextResponse = (text) => ({
    content: [{ type: "text", text }],
});
//# sourceMappingURL=index.js.map