# Magic Indexer

A simple Solana blockchain indexer that automatically populates a PostgreSQL database with parsed transactions and decoded account data.

## Overview

This indexer processes Solana transaction data and stores:
- **Parsed Transactions**: Organized by program ID in dedicated tables
- **Decoded Account Data**: Indexed by program owner with account details

## Features

- Automatic table creation with proper schemas
- Upsert operations to handle duplicate data
- Support for parsed instruction data and account information
- Flexible RPC integration via proxy headers

## Usage

### With Helius Webhooks

Configure your Helius webhook to send transaction data to this indexer endpoint. The service will automatically process incoming transactions and store the parsed data.

### With Geyser Plugin

Combine with a Geyser plugin to stream real-time transaction and account updates directly from a Solana validator.

## Environment Variables

```env
DB_URL=postgresql://user:password@host:port/database
RPC_URL=https://your-solana-rpc-endpoint
RPCX_URL=https://your-rpc-proxy-endpoint
```

## API

**POST** `/`
- Accepts transaction data with signatures and account keys
- Automatically fetches and stores parsed transaction details
- Returns `200` on success with "Account data stored"

## Database Schema

The indexer creates tables dynamically:
- `txs_program_{program_id}`: Transaction data per program
- `program_{program_id}`: Account data per program owner

Each table includes appropriate indexes and comments for easy querying.
