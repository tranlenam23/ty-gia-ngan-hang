"use strict";

var fs = require("fs");
var path = require("path");

var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var ROOT = path.join(__dirname, "..", "data");
var vtbActions = {
    times: "e4d951bbcfdef7e590919ae33e39d2a200f3d9e7",
    rates: "1e43a43a5124d6cc3cb463bc54021b34f39a4065"
};
var mbSession = null;

function isoOf(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, "0");
    var d = String(date.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
}

function parseDay(text) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

    if (!match) {
        throw new Error("Ngày phải là YYYY-MM-DD: " + text);
    }

    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function eachDate(from, to) {
    var days = [];
    var cursor = parseDay(from);
    var end = parseDay(to);

    while (cursor <= end) {
        days.push(isoOf(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }

    return days;
}

function readTable(bank) {
    var file = path.join(ROOT, bank + ".json");

    if (!fs.existsSync(file)) {
        return {};
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeTable(bank, table) {
    fs.mkdirSync(ROOT, { recursive: true });
    var keys = Object.keys(table).sort();
    var lines = keys.map(function (key) {
        return "  " + JSON.stringify(key) + ": " + JSON.stringify(table[key]);
    });
    fs.writeFileSync(path.join(ROOT, bank + ".json"), "{\n" + lines.join(",\n") + "\n}\n");
}

function asRate(value) {
    if (value == null || value === "" || value === 0 || value === "0") {
        return "";
    }

    var text = String(value).replace(/^\s+|\s+$/g, "");

    if (/^\d+\.0+$/.test(text)) {
        return text.replace(/\.0+$/, "");
    }

    return text;
}

function result(buy, sell, error) {
    if (!buy || !sell) {
        return { error: error };
    }

    return { buy: String(buy), sell: String(sell) };
}

function cookieHeader(response) {
    var list = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];

    return list.map(function (item) {
        return String(item).split(";")[0];
    }).filter(Boolean).join("; ");
}

function extractMbToken(html) {
    var match = String(html).match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);

    if (!match) {
        match = String(html).match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/);
    }

    return match ? match[1] : "";
}

async function loadMbSession(force) {
    if (!force && mbSession && mbSession.token && mbSession.cookie) {
        return mbSession;
    }

    var page = await fetch("https://www.mbbank.com.vn/ExchangeRate", {
        headers: {
            Accept: "text/html,application/xhtml+xml",
            Referer: "https://www.mbbank.com.vn/",
            "User-Agent": UA
        },
        signal: AbortSignal.timeout(25000)
    });
    var html = await page.text();
    var token = extractMbToken(html);
    var cookie = cookieHeader(page);

    if (!page.ok || !token || !cookie) {
        throw new Error("Không lấy được phiên MB");
    }

    mbSession = { token: token, cookie: cookie };
    return mbSession;
}

async function fetchMb(iso, retried) {
    var session = await loadMbSession(false);
    var response = await fetch("https://www.mbbank.com.vn/api/getExchangeRate/" + iso, {
        headers: {
            Accept: "application/json, text/plain, */*",
            Referer: "https://www.mbbank.com.vn/ExchangeRate",
            "MB-XSRF-Token-FormOnline": session.token,
            Cookie: session.cookie,
            "User-Agent": UA
        },
        signal: AbortSignal.timeout(25000)
    });

    if (response.status === 403 && !retried) {
        mbSession = null;
        await loadMbSession(true);
        return fetchMb(iso, true);
    }

    if (!response.ok) {
        return result("", "", "HTTP " + response.status);
    }

    var data = await response.json();
    var buy = "";
    var sell = "";
    var rows = data && data.lst ? data.lst : [];

    for (var i = 0; i < rows.length; i++) {
        if (rows[i].currencyCode === "USD") {
            buy = asRate(rows[i].buy_bank_transfer);
            sell = asRate(rows[i].sell_bank_transfer);
            break;
        }
    }

    return result(buy, sell, "Không tìm thấy tỷ giá USD chuyển khoản");
}

function parseVtbPayload(text) {
    var match = String(text).match(/(?:^|\n)1:(\[[\s\S]*\])\s*$/);

    if (!match) {
        return null;
    }

    try {
        return JSON.parse(match[1]);
    } catch (e) {
        return null;
    }
}

async function postVtb(action, body) {
    var response = await fetch("https://www.vietinbank.vn/ca-nhan/ty-gia-khcn", {
        method: "POST",
        headers: {
            Accept: "text/x-component",
            "Content-Type": "text/plain;charset=UTF-8",
            "Next-Action": action,
            Origin: "https://www.vietinbank.vn",
            Referer: "https://www.vietinbank.vn/ca-nhan/ty-gia-khcn",
            "User-Agent": UA
        },
        body: body,
        signal: AbortSignal.timeout(25000)
    });
    var text = await response.text();

    return { status: response.status, text: text };
}

function latestSlot(list) {
    return list.reduce(function (best, slot) {
        return String(slot.apply_date) > String(best.apply_date) ? slot : best;
    });
}

async function fetchVtb(iso) {
    var times = await postVtb(vtbActions.times, "[\"" + iso + "\"]");
    var slots = times.status >= 200 && times.status < 300
        ? parseVtbPayload(times.text)
        : null;

    if (!slots || !slots.length) {
        return result("", "", "Không có tỷ giá VietinBank cho ngày này");
    }

    var slot = latestSlot(slots);
    var rates = await postVtb(
        vtbActions.rates,
        "[\"" + slot.apply_date + "\",[\"USD\"]]"
    );

    if (rates.status < 200 || rates.status >= 300) {
        return result("", "", "HTTP " + rates.status);
    }

    var rows = parseVtbPayload(rates.text) || [];
    var buy = "";
    var sell = "";

    for (var i = 0; i < rows.length; i++) {
        if (rows[i].currency_code === "USD") {
            buy = asRate(rows[i].transfer_rate);
            sell = asRate(rows[i].sell_rate);
            break;
        }
    }

    return result(buy, sell, "Không tìm thấy tỷ giá USD chuyển khoản");
}

async function fetchStb(iso) {
    var versionsResponse = await fetch(
        "https://www.sacombank.com.vn/cong-cu/ty-gia/_jcr_content.sacom.exchange-rate.versions." + iso + ".json",
        {
            headers: {
                Accept: "application/json, text/plain, */*",
                Referer: "https://www.sacombank.com.vn/cong-cu/ty-gia.html",
                "User-Agent": UA
            },
            signal: AbortSignal.timeout(25000)
        }
    );

    if (!versionsResponse.ok) {
        return result("", "", "HTTP " + versionsResponse.status);
    }

    var versions = await versionsResponse.json();

    if (!versions || versions.statusCode !== 200 || !versions.data || !versions.data.length) {
        return result("", "", "Không có tỷ giá Sacombank cho ngày này");
    }

    var latestTime = versions.data[0];
    var rateResponse = await fetch(
        "https://www.sacombank.com.vn/cong-cu/ty-gia/_jcr_content.sacom.exchange-rate." +
        iso + "." + encodeURIComponent(latestTime) + ".json",
        {
            headers: {
                Accept: "application/json, text/plain, */*",
                Referer: "https://www.sacombank.com.vn/cong-cu/ty-gia.html",
                "User-Agent": UA
            },
            signal: AbortSignal.timeout(25000)
        }
    );

    if (!rateResponse.ok) {
        return result("", "", "HTTP " + rateResponse.status);
    }

    var payload = await rateResponse.json();
    var rows = payload && payload.statusCode === 200 && payload.data ? payload.data : [];
    var buy = "";
    var sell = "";

    for (var i = 0; i < rows.length; i++) {
        if (rows[i].currencyCode === "USD") {
            buy = asRate(rows[i].bidInTransfer);
            sell = asRate(rows[i].offerInTransfer);
            break;
        }
    }

    return result(buy, sell, "Không tìm thấy tỷ giá USD chuyển khoản");
}

async function fetchBank(bank, iso) {
    if (bank === "mb") {
        return fetchMb(iso, false);
    }

    if (bank === "vtb") {
        return fetchVtb(iso);
    }

    if (bank === "stb") {
        return fetchStb(iso);
    }

    throw new Error("Ngân hàng không hỗ trợ: " + bank);
}

function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

function argValue(name, fallback) {
    var index = process.argv.indexOf(name);

    if (index === -1 || !process.argv[index + 1]) {
        return fallback;
    }

    return process.argv[index + 1];
}

async function main() {
    var today = isoOf(new Date());
    var recent = argValue("--recent", "");
    var from = argValue("--from", "");
    var to = argValue("--to", today);
    var refresh = process.argv.indexOf("--refresh") !== -1;

    if (recent) {
        var start = new Date();
        start.setDate(start.getDate() - (Number(recent) - 1));
        from = isoOf(start);
    }

    if (!from) {
        throw new Error("Cần --from YYYY-MM-DD hoặc --recent N");
    }

    var banks = (argValue("--banks", "mb,vtb,stb")).split(",");
    var days = eachDate(from, to);
    var tables = {};

    banks.forEach(function (bank) {
        tables[bank] = readTable(bank);
    });

    console.log("Ngày " + days[0] + " → " + days[days.length - 1] + " (" + days.length + ")");

    for (var i = 0; i < days.length; i++) {
        var iso = days[i];
        var pending = banks.filter(function (bank) {
            return refresh || !Object.prototype.hasOwnProperty.call(tables[bank], iso);
        });

        if (!pending.length) {
            continue;
        }

        var settled = await Promise.all(pending.map(async function (bank) {
            try {
                return { bank: bank, row: await fetchBank(bank, iso) };
            } catch (error) {
                return { bank: bank, row: { error: error.message || String(error) } };
            }
        }));

        settled.forEach(function (item) {
            var previous = tables[item.bank][iso];

            if (item.row.error && previous && previous.buy) {
                console.log(iso + " " + item.bank + " giữ " + previous.buy + "/" + previous.sell + " (" + item.row.error + ")");
                return;
            }

            tables[item.bank][iso] = item.row;
            var label = item.row.buy
                ? item.row.buy + "/" + item.row.sell
                : item.row.error;
            console.log(iso + " " + item.bank + " " + label);
        });

        if (i % 10 === 0) {
            banks.forEach(function (bank) {
                writeTable(bank, tables[bank]);
            });
        }

        await sleep(200);
    }

    banks.forEach(function (bank) {
        writeTable(bank, tables[bank]);
        console.log("Ghi data/" + bank + ".json (" + Object.keys(tables[bank]).length + " ngày)");
    });
}

main().catch(function (error) {
    console.error(error);
    process.exit(1);
});
