import fetch from 'node-fetch';
import { logger } from './logger.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

async function coday(url, method, headers, payloadData = null, proxy = null) {
    try {
        const options = {
            method,
            headers,
        };

        if (payloadData) {
            options.body = JSON.stringify(payloadData);
        }

        if (proxy) {
            const agent = new HttpsProxyAgent(proxy);
            options.agent = agent;
        }

        const response = await fetch(url, options);
        const jsonData = await response.json().catch(() => ({}));

        if (!response.ok) {
            return { error: true, status: response.status, data: jsonData };
        }
        return jsonData;
    } catch (error) {
        logger(`Error in coday: ${error.message}`, 'error');
        return { error: true, message: error.message };
    }
}

async function estimate(id, headers, proxy) {
    const url = 'https://api.meshchain.ai/meshmain/rewards/estimate';
    const result = await coday(url, 'POST', headers, { unique_id: id }, proxy);

    return result || undefined;
}

async function claim(id, headers, proxy) {
    const url = 'https://api.meshchain.ai/meshmain/rewards/claim';
    const result = await coday(url, 'POST', headers, { unique_id: id }, proxy);
    console.log(result);
    return result.total_reward || null;
}

async function start(id, headers, proxy) {
    const url = 'https://api.meshchain.ai/meshmain/rewards/start';
    const result = await coday(url, 'POST', headers, { unique_id: id }, proxy);

    return result || null;
}

async function info(id, headers, proxy) {
    const url = 'https://api.meshchain.ai/meshmain/nodes/status';
    const result = await coday(url, 'POST', headers, { unique_id: id }, proxy);

    return result || null;
}

async function infoSpin(headers, proxy) {
    const url = 'https://api.meshchain.ai/meshmain/lucky-wheel/next-round';
    const result = await coday(url, 'GET', headers, null, proxy);

    return result || null;
}

async function doSpin(headers, proxy) {
    const url = 'https://api.meshchain.ai/meshmain/lucky-wheel/spin';
    const result = await coday(url, 'POST', headers, {}, proxy);

    return result || null;
}

async function init(headers, unique_id, proxy) {
    const url = "https://api.meshchain.ai/meshmain/nodes/link";
    const payload = { unique_id, "node_type": "browser", "name": "Extension" };

    const response = await coday(url, 'POST', headers, payload, proxy);
    return response || null;
}
async function getTokensInfo(headers, proxy) {
    const url = 'https://api.meshchain.ai/meshmain/wallet/tokens';
    const result = await coday(url, 'GET', headers, null, proxy);

    return result || null;
}
async function withdraw(to_address, asset_address, usdtAmount, headers, proxy) {
    const payload = {
        to_address,
        asset_address,
        total_amount: usdtAmount
    };
    const url = 'https://api.meshchain.ai/meshmain/withdraw';
    const result = await coday(url, 'POST', headers, payload, proxy);

    return result || null;
}
export { coday, estimate, claim, start, info, infoSpin, doSpin, init, withdraw, getTokensInfo };
