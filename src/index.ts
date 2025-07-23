import postgres from 'postgres';

const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

interface Env {
	DB_URL: string;
	RPC_URL: string;
	RPCX_URL: string;
	AUTH_HEADER: string;
}

function getDb(dbUrl: string) {
	return postgres(dbUrl);
}

async function ensureTableExists(db: postgres.Sql, tableName: string, schema: string, comment?: string) {
	await db.unsafe(`CREATE TABLE IF NOT EXISTS ${tableName} (${schema})`);
	if (comment) {
		const safeComment = comment.replace(/'/g, "''");
		await db.unsafe(`COMMENT ON TABLE ${tableName} IS '${safeComment}'`);
	}
}


async function upsertTransaction(db: postgres.Sql, programId: string, programName: string, tx: {
	feePayer: string;
	data: any;
	name: string;
	accounts: string[];
	signature: string;
}) {
	const tableName = `${`txs_program_${programId}`.toLowerCase()}`;

	await ensureTableExists(
		db,
		tableName,
		`signature TEXT PRIMARY KEY,
		   feePayer TEXT,
		   name TEXT,
		   data JSONB,
		   accounts TEXT[],
		   timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
		   `${programName}: transactions for program (${programId})`
	);

	await db`
		INSERT INTO ${db(tableName)} (signature, feePayer, name, data, accounts)
		VALUES (${tx.signature}, ${tx.feePayer}, ${tx.name}, ${tx.data}, ${tx.accounts})
		ON CONFLICT (signature) DO UPDATE SET
			name = EXCLUDED.name,
			data = EXCLUDED.data,
			accounts = EXCLUDED.accounts
	`;
}

async function upsertParsedAccount(db: postgres.Sql, acc: any) {
	const programId = acc?.owner?.toLowerCase()?.replace(/[^a-z0-9_]/g, '_');
	if (!programId) return;

	const tableName = `${`program_${programId}`.toLowerCase()}`;
	await ensureTableExists(db, tableName, `
		pubkey TEXT PRIMARY KEY,
		data JSONB,
		type TEXT,
		space BIGINT,
		lamports BIGINT
	`, 'Stores parsed account data indexed by pubkey for a specific Solana program.');

	await db`
			INSERT INTO ${db(tableName)} (pubkey, data, type, space, lamports)
			VALUES (${acc.key}, ${acc.data}, ${acc.name}, ${acc.space}, ${acc.lamports})
			ON CONFLICT (pubkey) DO UPDATE SET
				data = EXCLUDED.data,
				type = EXCLUDED.type,
				space = EXCLUDED.space,
				lamports = EXCLUDED.lamports
		`;
}


// Function to extract program ID from log messages
function extractProgramIdFromLogs(logMessages: string[], targetLogMessage: string): string | null {
	try {
		const targetLogIndex = logMessages.findIndex(msg =>
			msg.includes(targetLogMessage)
		);
		if (targetLogIndex <= 0) {
			return null;
		}
		for (let i = targetLogIndex - 1; i >= 0; i--) {
			const currentMsg = logMessages[i];
			const programInvokeMatch = currentMsg.match(/^Program\s+([A-HJ-NP-Za-km-z1-9]{32,44})\s+invoke\s+\[1\]$/);
			if (programInvokeMatch) {
				return programInvokeMatch[1];
			}
		}
		return null;
	} catch (error: any) {
		return null;
	}
}

async function rpcFetch(rpcUrl: string, rpcxUrl: string,  method: string, params: any): Promise<any> {
	const body = {
		jsonrpc: "2.0",
		id: "0",
		method,
		params
	};

	const res = await fetch(rpcxUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Rpc": rpcUrl
		},
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		throw new Error(`RPC error: ${await res.text()}`);
	}

	const json = await res.json();
	// @ts-ignore
	if (!json.result) throw new Error("RPC result missing");
	// @ts-ignore
	return json.result;
}

export default {
	async fetch(request, env: Env, _ctx): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const authHeader = request.headers.get('Authorization');
		if (authHeader !== env.AUTH_HEADER) {
			return new Response("Unauthorized", { status: 401 });
		}

		const db = getDb(env.DB_URL);

		try {
			const body = await request.json();
			// @ts-ignore
			const signature = body?.[0]?.transaction?.signatures?.[0];
			// @ts-ignore
			const accountKeys = body?.[0]?.transaction?.message?.accountKeys;

			if (!signature || !accountKeys) {
				return new Response("Invalid input", { status: 400 });
			}

			const txResult = await rpcFetch(env.RPC_URL, env.RPCX_URL, "getParsedTransaction", [signature, { commitment: "confirmed" }]);
			const message = txResult?.transaction?.message;
			const feePayer = message?.accountKeys?.[0];
			// @ts-ignore
			const logMessages = body?.[0]?.meta?.logMessages

			// @ts-ignore
			if(accountKeys.includes(DELEGATION_PROGRAM) && logMessages.some(msg => msg.includes("Program log: Processing instruction: Delegate"))){
				console.log("Contains delegation")
				const extractedProgramId = extractProgramIdFromLogs(
					logMessages,
					"Program log: Processing instruction: Delegate"
				);
				console.log(extractedProgramId)
				await upsertTransaction(db, DELEGATION_PROGRAM, "Delegation Program", {
					feePayer,
					name: "Delegate",
					data: {program: extractedProgramId},
					accounts: accountKeys,
					signature
				});
			}

			let txPromises = Promise.all(
				(message?.instructions || []).map(async (inst: any) => {
					if (inst.programId && inst.parsedData) {
						const accounts = (inst.accounts || []).map((idx: number) => accountKeys[idx]);
						await upsertTransaction(db, inst.programId, inst.programName, {
							feePayer,
							name: inst.name,
							data: inst.parsedData,
							accounts,
							signature
						});
					}
				})
			);

			const parsedData = await rpcFetch(env.RPC_URL, env.RPCX_URL, "getParsedAccountsData", {
				pubkeys: accountKeys,
				commitment: "processed",
				onlyParsed: true
			});

			const parsedAccounts = (parsedData.value || []).filter((acc: any) => acc?.parsed === true);
			// @ts-ignore
			const accountsPromises = Promise.all(parsedAccounts.map(acc => upsertParsedAccount(db, acc)));

			await txPromises;
			await accountsPromises;

			return new Response("Account data stored", { status: 200 });
		} catch (err: any) {
			console.error("Error:", err);
			return new Response(`Error: ${err.message}`, { status: 500 });
		}
	}
} satisfies ExportedHandler<Env>;
