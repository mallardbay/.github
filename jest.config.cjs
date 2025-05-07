module.exports = {
    preset: "ts-jest/presets/default-esm", // ✅ ESM-compatible preset
    testEnvironment: "node",
    extensionsToTreatAsEsm: [".ts"],
    transform: {
        "^.+\\.ts$": [
            "ts-jest",
            {
                useESM: true,
            },
        ],
    },
    globals: {
        "ts-jest": {
            useESM: true,
            tsconfig: "tsconfig.json",
        },
    },
    moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1", // Fix for ESM import paths
    },
};
