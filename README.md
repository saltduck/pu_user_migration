# User Migration

This project provides a script to migrate user funds from an old version of a DeFi protocol to a new one.

## Installation

```bash
npm install
```

## Usage

### Run tests

```bash
npm test
```

### Run migration from the command line

```bash
# Make sure to set up your environment variables, such as the private key of the wallet to use for the migration.
node src/index.js
```

### Run migration from the browser

```bash
npm run build && npm run dev
```

Then open your browser to `http://localhost:3000`.

## Migration Logic

The migration process is divided into two parts:

1.  **MasterChef Migration**: Migrates LP tokens from the old MasterChef contract to the new one.
2.  **SousChef Migration**: Migrates tokens from the old SousChef contract to the new one.

The script is designed to be resumable. If it fails for any reason, you can simply run it again, and it will pick up where it left off. This is achieved by storing the migration state in the browser's `localStorage`.