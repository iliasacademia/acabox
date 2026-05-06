module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx', '**/?(*.)+(spec|test).ts', '**/?(*.)+(spec|test).tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
  ],
  transformIgnorePatterns: [
    // Whitelist ESM packages that need transforming. html-react-parser pulls
    // in domhandler/domelementtype/domutils as ESM via its src/index.ts; the
    // others are pre-existing entries.
    'node_modules/(?!(axios-cookiejar-support|http-cookie-agent|tough-cookie-file-store|html-react-parser|domhandler|domelementtype|domutils|entities|htmlparser2)/)',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react',
        esModuleInterop: true,
      },
    }],
    '^.+\\.jsx?$': ['babel-jest'],
  },
  moduleNameMapper: {
    '^serialize-error$': '<rootDir>/src/__mocks__/serialize-error.ts',
    '^(\\.\\./)+deviceId$': '<rootDir>/src/__mocks__/deviceId.ts',
    // Stub out CSS imports so .tsx files that load global stylesheets don't
    // blow up Jest. Renderer components import from `*.css` for side-effects
    // (e.g. `'@assistant-ui/react-markdown/styles/dot.css'`); the test only
    // cares about the React tree.
    '\\.css$': '<rootDir>/src/__mocks__/styleMock.js',
  },
};
