import { coday, estimate, claim, start, info, infoSpin, doSpin, init } from './scripts.js';
import { logger } from './logger.js';
import fs from 'fs/promises';
import { banner } from './banner.js';

let headers = {
    'Content-Type': 'application/json',
};

async function readTokensAndIds() {
    try {
        const tokenData = await fs.readFile('token.txt', 'utf-8');
        const tokens = tokenData
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && line.includes('|'));

        const idsData = await fs.readFile('unique_id.txt', 'utf-8');
        const uniqueIds = idsData
            .split('\n')
            .map(line => line.trim())
            .filter(line => line);

        let proxies = [];
        try {
            const proxyData = await fs.readFile('proxy.txt', 'utf-8');
            proxies = proxyData.split('\n').filter(line => line.trim());
        } catch (err) {
            logger("File proxy.txt not found, Running without proxy", 'warn');
        }

        if (proxies.length === 0) {
            proxies = null;
        }

        if (tokens.length !== uniqueIds.length) {
            logger("Mismatch between the number of tokens and unique ID lines.", "error");
            return [];
        }

        const accounts = tokens.map((line, index) => {
            const [access_token, refresh_token] = line.split('|').map(token => token.trim());
            const ids = uniqueIds[index].includes('|')
                ? uniqueIds[index].split('|').map(id => id.trim())
                : [uniqueIds[index].trim()];

            return { access_token, refresh_token, unique_ids: ids, proxy: proxies ? proxies[index % proxies.length] : null };
        });

        return accounts;
    } catch (err) {
        logger("Failed to read token or unique ID file:", "error", err.message);
        return [];
    }
}

const asyncLock = {};
const tokenLocks = new Set();

async function lockAndWrite(file, content) {
    while (asyncLock[file]) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    asyncLock[file] = true;

    try {
        await fs.writeFile(file, content, 'utf-8');
    } finally {
        asyncLock[file] = false;
    }
}

async function refreshToken(refresh_token, accountIndex) {
    if (tokenLocks.has(accountIndex)) {
        logger(`Account ${accountIndex + 1} is already refreshing. Waiting...`, "info");
        while (tokenLocks.has(accountIndex)) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return null;
    }

    tokenLocks.add(accountIndex);

    try {
        logger(`Refreshing access token for Account ${accountIndex + 1}...`, "info");
        const payloadData = { refresh_token };
        const response = await coday("https://api.meshchain.ai/meshmain/auth/refresh-token", 'POST', headers, payloadData);

        if (response && response.access_token) {
            const tokenLines = (await fs.readFile('token.txt', 'utf-8'))
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);

            tokenLines[accountIndex] = `${response.access_token}|${response.refresh_token}`.trim();
            await lockAndWrite('token.txt', tokenLines.join('\n') + '\n');
            logger(`Account ${accountIndex + 1} token refreshed successfully`, "success");
            return response.access_token;
        }

        logger(`Account ${accountIndex + 1} failed to refresh token`, "error");
        console.log(response);
        return null;
    } catch (err) {
        logger(`Error refreshing token for Account ${accountIndex + 1}: ${err.message}`, "error");
        return null;
    } finally {
        tokenLocks.delete(accountIndex);
    }
}

// Main process for a single account
async function processAccount({ access_token, refresh_token, unique_ids, proxy }, accountIndex) {
    headers = {
        ...headers,
        Authorization: `Bearer ${access_token}`,
    };

    for (const unique_id of unique_ids) {
        try {
            const profile = await info(unique_id, headers, proxy);
            if (profile && profile.error) {
                const { status, data } = profile;

                if (status === 401) {
                    const message = data?.message || 'Unknown error';
                    logger(`Account ${accountIndex + 1} | ${unique_id}: Unauthorized (Error Code: ${data?.code}), ${message}`, "warn");

                    if (data.code === '40100002') {
                        logger(`Account ${accountIndex + 1} | ${unique_id}: JWT token expired, attempting to refresh...`, "warn");
                        const newAccessToken = await refreshToken(refresh_token, accountIndex);
                        if (!newAccessToken) return;
                        headers.Authorization = `Bearer ${newAccessToken}`;
                        return;
                    }
                } else {
                    logger(`Account ${accountIndex + 1} | ${unique_id}: Error fetching profile (Code: ${data?.code}), ${data?.message}`, "error");
                }
            }

            else if (profile) {
                const is_linked = profile.is_linked || false;

                if (!is_linked) {
                    logger(`Account ${accountIndex + 1} | ${unique_id}: Node not linked, attempting to link node...`, "warn");
                    try {
                        await init(headers, unique_id, proxy);
                        logger(`Account ${accountIndex + 1} | ${unique_id}: Node linked successfully.`, "success");
                    } catch (err) {
                        logger(`Account ${accountIndex + 1} | ${unique_id}: Failed to link node: ${err.message}`, "error");
                    }
                }

                const { name, total_reward } = profile;
                logger(`Account ${accountIndex + 1} | ${unique_id}: ${name} | Balance: ${total_reward}`, "success");
            } else {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Profile data is invalid or missing.`, "error");
            }
        } catch (err) {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Error fetching profile: ${err.message}`, "error");
        }

        const filled = await estimate(unique_id, headers, proxy);
        if (!filled) {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Failed to fetch estimate.`, "error");
            continue;
        } else if (filled.error) {
            const errorMessage = filled.data ? filled.data.message : 'Unknown error';
            logger(`Account ${accountIndex + 1} | ${unique_id}: ${errorMessage}`, "error");

            if (filled.data && filled.data.status === 400) {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Trying to restart mining again due to status 400.`, "info");
                await start(unique_id, headers);
            } else if (filled.data && filled.data.status === 401) {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Unauthorized. Attempting to refresh token...`, "warn");
                const newAccessToken = await refreshToken(refresh_token, accountIndex);
                if (!newAccessToken) return;
                headers.Authorization = `Bearer ${newAccessToken}`;
                return;
            }
        }

        if (filled.filled && filled.claimable) {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Attempting to claim reward...`, "info");
            const reward = await claim(unique_id, headers, proxy);
            if (reward) {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Claim successful! New Balance: ${reward}`, "success");
                await start(unique_id, headers);
                logger(`Account ${accountIndex + 1} | ${unique_id}: Started mining again.`, "info");
            } else {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Failed to claim reward. Ensure your BNB balance is enough.`, "error");
            }
        } else {
            logger(`Account ${accountIndex + 1} | ${unique_id}: Mining already started. Mine value: ${filled.value}`, "info");
        }
    }

};

async function spins() {
    logger('Checking Current Round Spins Information...');
    const accounts = await readTokensAndIds();

    if (accounts.length === 0) {
        logger("No accounts to process.", "error");
        return;
    }

    logger(`Processing Checking ${accounts.length} accounts...`, "info");

    for (let index = 0; index < accounts.length; index++) {
        const account = accounts[index];

        headers = {
            ...headers,
            Authorization: `Bearer ${account.access_token}`,
        };

        try {
            const spinsData = await infoSpin(headers, account.proxy);
            if (spinsData) {
                const timeNow = Math.floor(Date.now() / 1000);
                const { spinStartTime, spinEndTime, maxSpinPerUser, userCurrentSpin } = spinsData;
                const timesNow = {
                    timeNow: new Date(timeNow * 1000).toLocaleString(),
                    spinEndTime: new Date(spinEndTime * 1000).toLocaleString(),
                    spinStartTime: new Date(spinStartTime * 1000).toLocaleString(),
                };

                if (timeNow > spinStartTime && timeNow < spinEndTime && userCurrentSpin < maxSpinPerUser) {
                    logger(`Account ${index + 1}: Let's do Spinning...`);
                    const spinResult = await doSpin(headers, account.proxy);
                    console.log(`Spins result for Account ${index + 1}:`, spinResult);
                } else {
                    logger(`Account ${index + 1}: The current round has already ended, or you have reached the maximum allowed spins.`, 'warn');
                    logger(`Current time: ${timesNow.timeNow} | Next Round Spin Time: ${timesNow.spinStartTime}`, 'warn');
                }
            }
            logger(`Account ${index + 1} Check completed successfully, proxy: ${account.proxy}`, "info");
        } catch (error) {
            logger(`Error processing account ${index + 1}: ${error.message}`, "error");
        }
    }
}

async function main() {
    logger(banner, "debug");
    setInterval(spins, 15 * 60 * 1000); // 15 minutes interval for spins

    while (true) {
        const accounts = await readTokensAndIds();

        if (accounts.length === 0) {
            logger("No accounts to process.", "error");
            return;
        }

        logger(`Processing ${accounts.length} accounts...`, "info");

        for (let index = 0; index < accounts.length; index++) {
            const account = accounts[index];
            try {
                await processAccount(account, index);
                logger(`Account ${index + 1} processed successfully, proxy: ${account.proxy}`, "info");
            } catch (error) {
                logger(`Error processing account ${index + 1}: ${error.message}`, "error");
            }
        }

        logger("All accounts processed. Waiting 10 minute for the next run.", "info");
        await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000)); // 10 minutes interval
    }
}

process.on('SIGINT', () => {
    logger('Process terminated by user.', 'warn');
    process.exit(0);
});

// let Start
main();

