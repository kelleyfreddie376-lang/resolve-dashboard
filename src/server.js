require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const db = require("./database/db");

const app = express();

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI =
    process.env.REDIRECT_URI ||
    "http://localhost:3000/auth/discord/callback";

const DISCORD_API = "https://discord.com/api/v10";

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn("⚠️ CLIENT_ID or CLIENT_SECRET is missing from .env");
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
    session({
        secret: process.env.SESSION_SECRET || "resolve-dashboard-secret",

        resave: false,

        saveUninitialized: false,

        cookie: {
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    })
);

app.use(express.static(path.join(__dirname, "public")));

/* --------------------------------------------------
   HELPERS
-------------------------------------------------- */

async function discordRequest(url, options = {}) {
    const response = await fetch(url, options);

    if (!response.ok) {
        const text = await response.text();

        throw new Error(
            `Discord API error ${response.status}: ${text}`
        );
    }

    return response.json();
}

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect("/auth/discord");
    }

    next();
}

function getGuildIds(req) {
    if (!req.session.guilds) {
        return [];
    }

    return req.session.guilds.map((guild) => guild.id);
}

function hasManageGuild(guild) {
    const permissions = BigInt(guild.permissions || "0");
    const MANAGE_GUILD = 1n << 5n;

    return (
        (permissions & MANAGE_GUILD) === MANAGE_GUILD ||
        guild.owner === true
    );
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/* --------------------------------------------------
   HOME
-------------------------------------------------- */

app.get("/", (req, res) => {
    if (req.session.user) {
        return res.redirect("/dashboard");
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Resolve Dashboard</title>

    <style>
        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #0f1117;
            color: #ffffff;
        }

        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 80px 24px;
            text-align: center;
        }

        h1 {
            font-size: 52px;
            margin-bottom: 12px;
        }

        p {
            color: #aeb4c0;
            font-size: 18px;
            line-height: 1.6;
        }

        .button {
            display: inline-block;
            margin-top: 30px;
            padding: 14px 24px;
            border-radius: 10px;
            background: #5865f2;
            color: white;
            text-decoration: none;
            font-weight: bold;
        }

        .button:hover {
            background: #4752c4;
        }
    </style>
</head>

<body>
    <div class="container">
        <h1>Resolve</h1>

        <p>
            AI-powered support for Discord.
        </p>

        <p>
            Manage your server's support system,
            knowledge, tickets, and AI settings.
        </p>

        <a class="button" href="/auth/discord">
            Login with Discord
        </a>
    </div>
</body>
</html>
    `);
});

/* --------------------------------------------------
   DISCORD LOGIN
-------------------------------------------------- */

app.get("/auth/discord", (req, res) => {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: "identify guilds"
    });

    res.redirect(
        `https://discord.com/oauth2/authorize?${params.toString()}`
    );
});

/* --------------------------------------------------
   DISCORD CALLBACK
-------------------------------------------------- */

app.get("/auth/discord/callback", async (req, res) => {
    try {
        const { code } = req.query;

        if (!code) {
            return res.status(400).send("Missing Discord authorization code.");
        }

        const tokenBody = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI
        });

        const tokenResponse = await fetch(
            `${DISCORD_API}/oauth2/token`,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },
                body: tokenBody
            }
        );

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();

            console.error(
                "Discord token error:",
                errorText
            );

            return res
                .status(500)
                .send("Discord login failed.");
        }

        const tokenData = await tokenResponse.json();

        const user = await discordRequest(
            `${DISCORD_API}/users/@me`,
            {
                headers: {
                    Authorization:
                        `Bearer ${tokenData.access_token}`
                }
            }
        );

        const guilds = await discordRequest(
            `${DISCORD_API}/users/@me/guilds`,
            {
                headers: {
                    Authorization:
                        `Bearer ${tokenData.access_token}`
                }
            }
        );

        req.session.user = user;
        req.session.guilds = guilds;
        req.session.accessToken = tokenData.access_token;

        console.log(
            `✅ Discord login: ${user.username} (${user.id})`
        );

        res.redirect("/dashboard");
    } catch (error) {
        console.error(
            "❌ Discord callback error:",
            error
        );

        res
            .status(500)
            .send("Something went wrong while logging in with Discord.");
    }
});

/* --------------------------------------------------
   LOGOUT
-------------------------------------------------- */

app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/");
    });
});

/* --------------------------------------------------
   DASHBOARD
-------------------------------------------------- */

app.get("/dashboard", requireLogin, async (req, res) => {
    try {
        const guilds = (req.session.guilds || []).filter(
            hasManageGuild
        );

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>Resolve Dashboard</title>

    <style>
        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #0f1117;
            color: #ffffff;
        }

        header {
            padding: 18px 24px;
            border-bottom: 1px solid #252936;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .brand {
            font-size: 22px;
            font-weight: bold;
        }

        .user {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .user img {
            width: 36px;
            height: 36px;
            border-radius: 50%;
        }

        .logout {
            color: #ff6b6b;
            text-decoration: none;
        }

        main {
            max-width: 1100px;
            margin: 0 auto;
            padding: 40px 24px;
        }

        h1 {
            margin-bottom: 8px;
        }

        .subtitle {
            color: #9ca3af;
            margin-bottom: 30px;
        }

        .servers {
            display: grid;
            grid-template-columns:
                repeat(auto-fit, minmax(260px, 1fr));
            gap: 18px;
        }

        .server {
            background: #181b24;
            border: 1px solid #282d3a;
            border-radius: 14px;
            padding: 22px;
        }

        .server h2 {
            margin-top: 0;
            font-size: 20px;
        }

        .server p {
            color: #9ca3af;
        }

        .open {
            display: inline-block;
            margin-top: 12px;
            padding: 10px 16px;
            border-radius: 8px;
            background: #5865f2;
            color: white;
            text-decoration: none;
            font-weight: bold;
        }

        .empty {
            background: #181b24;
            border: 1px solid #282d3a;
            border-radius: 14px;
            padding: 30px;
            color: #9ca3af;
        }
    </style>
</head>

<body>

<header>
    <div class="brand">Resolve Dashboard</div>

    <div class="user">
        <span>${escapeHtml(req.session.user.username)}</span>
        <a class="logout" href="/logout">Logout</a>
    </div>
</header>

<main>
    <h1>Your Servers</h1>

    <div class="subtitle">
        Select a Discord server to manage Resolve.
    </div>

    <div class="servers">
        ${
            guilds.length
                ? guilds
                    .map(
                        (guild) => `
                            <div class="server">
                                <h2>
                                    ${escapeHtml(guild.name)}
                                </h2>

                                <p>
                                    Manage Resolve for this server.
                                </p>

                                <a
                                    class="open"
                                    href="/dashboard/server/${encodeURIComponent(guild.id)}"
                                >
                                    Open Dashboard
                                </a>
                            </div>
                        `
                    )
                    .join("")
                : `
                    <div class="empty">
                        <strong>No manageable servers found.</strong>
                        <br><br>
                        You need Manage Server permissions
                        or server ownership to manage Resolve.
                    </div>
                `
        }
    </div>
</main>

</body>
</html>
        `);
    } catch (error) {
        console.error(
            "❌ Dashboard error:",
            error
        );

        res
            .status(500)
            .send("Unable to load the dashboard.");
    }
});

/* --------------------------------------------------
   SERVER ACCESS CHECK
-------------------------------------------------- */

function getManageableGuild(req, guildId) {
    const guild = (req.session.guilds || []).find(
        (item) => item.id === guildId
    );

    if (!guild) {
        return null;
    }

    if (!hasManageGuild(guild)) {
        return null;
    }

    return guild;
}

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

app.listen(PORT, () => {
    console.log(
        `🚀 Resolve Dashboard running on port ${PORT}`
    );
});
/* --------------------------------------------------
   SERVER DASHBOARD
-------------------------------------------------- */

app.get("/dashboard/server/:guildId", requireLogin, async (req, res) => {
    try {
        const { guildId } = req.params;

        const guild = getManageableGuild(req, guildId);

        if (!guild) {
            return res.status(403).send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Access Denied - Resolve</title>

    <style>
        body {
            margin: 0;
            background: #0f1117;
            color: white;
            font-family: Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }

        .box {
            width: 90%;
            max-width: 500px;
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 16px;
            padding: 35px;
            text-align: center;
        }

        h1 {
            margin-top: 0;
        }

        p {
            color: #9ca3af;
            line-height: 1.6;
        }

        a {
            display: inline-block;
            margin-top: 15px;
            padding: 11px 18px;
            border-radius: 8px;
            background: #5865f2;
            color: white;
            text-decoration: none;
            font-weight: bold;
        }
    </style>
</head>

<body>
    <div class="box">
        <h1>Access Denied</h1>

        <p>
            You don't have permission to manage this Discord server
            through Resolve.
        </p>

        <a href="/dashboard">
            Back to Servers
        </a>
    </div>
</body>
</html>
            `);
        }

        const ticketStats = await db.query(
            `
            SELECT
                COUNT(*) FILTER (
                    WHERE status = 'open'
                )::int AS open,

                COUNT(*) FILTER (
                    WHERE status = 'human'
                )::int AS claimed,

                COUNT(*) FILTER (
                    WHERE status = 'closed'
                )::int AS closed,

                COUNT(*) FILTER (
                    WHERE created_at >= CURRENT_DATE
                )::int AS today

            FROM tickets
            WHERE guild_id = $1
            `,
            [guildId]
        );

        const knowledgeStats = await db.query(
            `
            SELECT
                COUNT(*)::int AS total,

                COUNT(*) FILTER (
                    WHERE approved = TRUE
                )::int AS approved

            FROM knowledge
            WHERE guild_id = $1
            `,
            [guildId]
        );

        const stats = ticketStats.rows[0] || {
            open: 0,
            claimed: 0,
            closed: 0,
            today: 0
        };

        const knowledge = knowledgeStats.rows[0] || {
            total: 0,
            approved: 0
        };

        res.send(`
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        ${escapeHtml(guild.name)} - Resolve
    </title>

    <style>
        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #0f1117;
            color: #ffffff;
        }

        header {
            height: 70px;
            border-bottom: 1px solid #272b36;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 25px;
            background: #12151c;
        }

        .brand {
            font-size: 21px;
            font-weight: 700;
        }

        .header-right {
            display: flex;
            align-items: center;
            gap: 18px;
        }

        .back {
            color: #aeb4c0;
            text-decoration: none;
        }

        .back:hover {
            color: white;
        }

        .logout {
            color: #ff6b6b;
            text-decoration: none;
        }

        main {
            max-width: 1150px;
            margin: 0 auto;
            padding: 35px 22px 60px;
        }

        .server-header {
            margin-bottom: 30px;
        }

        .server-header h1 {
            margin: 0 0 8px;
            font-size: 32px;
        }

        .server-header p {
            margin: 0;
            color: #9ca3af;
        }

        .stats {
            display: grid;
            grid-template-columns:
                repeat(auto-fit, minmax(180px, 1fr));

            gap: 16px;
            margin-bottom: 30px;
        }

        .stat {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 20px;
        }

        .stat-label {
            color: #9ca3af;
            font-size: 14px;
        }

        .stat-value {
            font-size: 30px;
            font-weight: bold;
            margin-top: 8px;
        }

        .cards {
            display: grid;
            grid-template-columns:
                repeat(auto-fit, minmax(280px, 1fr));

            gap: 18px;
        }

        .card {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 24px;
        }

        .card h2 {
            margin: 0 0 8px;
            font-size: 20px;
        }

        .card p {
            color: #9ca3af;
            line-height: 1.5;
            min-height: 48px;
        }

        .button {
            display: inline-block;
            margin-top: 10px;
            padding: 11px 17px;
            border-radius: 8px;
            background: #5865f2;
            color: white;
            text-decoration: none;
            font-weight: bold;
        }

        .button:hover {
            background: #4752c4;
        }

        .secondary {
            background: #252936;
        }

        .secondary:hover {
            background: #303544;
        }

        .knowledge-number {
            color: #a78bfa;
        }

        @media (max-width: 600px) {
            header {
                padding: 0 15px;
            }

            .header-right {
                gap: 10px;
                font-size: 14px;
            }

            main {
                padding: 25px 15px 50px;
            }

            .server-header h1 {
                font-size: 26px;
            }
        }
    </style>
</head>

<body>

<header>

    <div class="brand">
        Resolve
    </div>

    <div class="header-right">

        <a
            class="back"
            href="/dashboard"
        >
            Servers
        </a>

        <a
            class="logout"
            href="/logout"
        >
            Logout
        </a>

    </div>

</header>

<main>

    <div class="server-header">

        <h1>
            ${escapeHtml(guild.name)}
        </h1>

        <p>
            Manage Resolve's support system for this server.
        </p>

    </div>

    <div class="stats">

        <div class="stat">
            <div class="stat-label">
                Open Tickets
            </div>

            <div class="stat-value">
                ${stats.open}
            </div>
        </div>

        <div class="stat">
            <div class="stat-label">
                Claimed Tickets
            </div>

            <div class="stat-value">
                ${stats.claimed}
            </div>
        </div>

        <div class="stat">
            <div class="stat-label">
                Closed Tickets
            </div>

            <div class="stat-value">
                ${stats.closed}
            </div>
        </div>

        <div class="stat">
            <div class="stat-label">
                Tickets Today
            </div>

            <div class="stat-value">
                ${stats.today}
            </div>
        </div>

    </div>

    <div class="cards">

        <div class="card">

            <h2>
                🎫 Ticket Center
            </h2>

            <p>
                View, manage, claim, close, and review
                support tickets from your dashboard.
            </p>

            <a
                class="button"
                href="/dashboard/server/${encodeURIComponent(guildId)}/tickets"
            >
                Open Tickets
            </a>

        </div>

        <div class="card">

            <h2>
                🧠 Knowledge
            </h2>

            <p>
                Manage the approved information Resolve
                can use when answering support questions.
            </p>

            <p>
                <strong class="knowledge-number">
                    ${knowledge.approved}
                </strong>
                approved entries
            </p>

            <a
                class="button secondary"
                href="/dashboard/server/${encodeURIComponent(guildId)}/knowledge"
            >
                Manage Knowledge
            </a>

        </div>

        <div class="card">

            <h2>
                🤖 AI Settings
            </h2>

            <p>
                Configure how Resolve handles support
                questions and human handoffs.
            </p>

            <a
                class="button secondary"
                href="/dashboard/server/${encodeURIComponent(guildId)}/settings"
            >
                AI Settings
            </a>

        </div>

        <div class="card">

            <h2>
                📊 Support Stats
            </h2>

            <p>
                Review your server's support activity,
                ticket volume, and knowledge growth.
            </p>

            <a
                class="button secondary"
                href="/dashboard/server/${encodeURIComponent(guildId)}/tickets"
            >
                View Activity
            </a>

        </div>

    </div>

</main>

</body>
</html>
        `);

    } catch (error) {
        console.error(
            "❌ Server dashboard error:",
            error
        );

        res.status(500).send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Resolve Error</title>
</head>

<body
    style="
        background:#0f1117;
        color:white;
        font-family:Arial;
        padding:50px;
    "
>

    <h1>Resolve Dashboard Error</h1>

    <p>
        Something went wrong while loading this server.
    </p>

    <a
        href="/dashboard"
        style="color:#5865f2;"
    >
        Return to Dashboard
    </a>

</body>
</html>
        `);
    }
});

/* --------------------------------------------------
   TEMPORARY SETTINGS PAGE
-------------------------------------------------- */

app.get(
    "/dashboard/server/:guildId/settings",
    requireLogin,
    async (req, res) => {
        const { guildId } = req.params;

        const guild = getManageableGuild(req, guildId);

        if (!guild) {
            return res.status(403).send("Access denied.");
        }

        res.send(`
<!DOCTYPE html>
<html>

<head>
    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>AI Settings - Resolve</title>

    <style>
        body {
            margin: 0;
            background: #0f1117;
            color: white;
            font-family: Arial, sans-serif;
        }

        main {
            max-width: 850px;
            margin: 0 auto;
            padding: 45px 22px;
        }

        .box {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 25px;
        }

        p {
            color: #9ca3af;
            line-height: 1.6;
        }

        a {
            color: #5865f2;
        }
    </style>
</head>

<body>

<main>

    <div class="box">

        <h1>
            🤖 AI Settings
        </h1>

        <p>
            Resolve AI settings will be available here.
        </p>

        <a
            href="/dashboard/server/${encodeURIComponent(guildId)}"
        >
            ← Back to Server Dashboard
        </a>

    </div>

</main>

</body>

</html>
        `);
    }
);

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */

app.listen(PORT, () => {
    console.log(
        `🚀 Resolve Dashboard running on port ${PORT}`
    );
});
/* --------------------------------------------------
   KNOWLEDGE
-------------------------------------------------- */

app.get(
    "/dashboard/server/:guildId/knowledge",
    requireLogin,
    async (req, res) => {
        try {
            const { guildId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            const result = await db.query(
                `
                SELECT
                    id,
                    title,
                    content,
                    approved,
                    source_channel_id
                FROM knowledge
                WHERE guild_id = $1
                ORDER BY id DESC
                `,
                [guildId]
            );

            const entries = result.rows;

            const entryHtml = entries.length
                ? entries
                    .map((entry) => `
                        <div class="knowledge-entry">

                            <div class="entry-top">

                                <div>
                                    <h2>
                                        ${escapeHtml(entry.title)}
                                    </h2>

                                    <span class="entry-id">
                                        Knowledge #${entry.id}
                                    </span>
                                </div>

                                <span class="${
                                    entry.approved
                                        ? "approved"
                                        : "pending"
                                }">
                                    ${
                                        entry.approved
                                            ? "✓ Approved"
                                            : "Pending"
                                    }
                                </span>

                            </div>

                            <div class="content">
                                ${escapeHtml(entry.content)}
                            </div>

                            ${
                                entry.source_channel_id
                                    ? `
                                        <div class="source">
                                            Source channel:
                                            ${escapeHtml(
                                                entry.source_channel_id
                                            )}
                                        </div>
                                    `
                                    : ""
                            }

                        </div>
                    `)
                    .join("")
                : `
                    <div class="empty">
                        <h2>No knowledge yet</h2>

                        <p>
                            Resolve has not learned any approved
                            knowledge for this server yet.
                        </p>
                    </div>
                `;

            res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        Knowledge - ${escapeHtml(guild.name)}
    </title>

    <style>

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            background: #0f1117;
            color: white;
            font-family: Arial, sans-serif;
        }

        header {
            height: 70px;
            padding: 0 24px;
            border-bottom: 1px solid #272b36;
            background: #12151c;

            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .brand {
            font-size: 21px;
            font-weight: bold;
        }

        .header-links {
            display: flex;
            gap: 18px;
        }

        .header-links a {
            color: #aeb4c0;
            text-decoration: none;
        }

        .header-links a:hover {
            color: white;
        }

        main {
            max-width: 1100px;
            margin: 0 auto;
            padding: 35px 22px 60px;
        }

        .heading {
            margin-bottom: 28px;
        }

        .heading h1 {
            margin: 0 0 8px;
            font-size: 32px;
        }

        .heading p {
            margin: 0;
            color: #9ca3af;
        }

        .knowledge-entry {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 22px;
            margin-bottom: 16px;
        }

        .entry-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 15px;
        }

        .entry-top h2 {
            margin: 0 0 5px;
            font-size: 19px;
        }

        .entry-id {
            color: #727987;
            font-size: 13px;
        }

        .approved,
        .pending {
            padding: 6px 10px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: bold;
            white-space: nowrap;
        }

        .approved {
            background: #173b2c;
            color: #57f287;
        }

        .pending {
            background: #3c3215;
            color: #fee75c;
        }

        .content {
            margin-top: 18px;
            background: #11141b;
            border-radius: 9px;
            padding: 16px;
            color: #d6d9df;
            line-height: 1.6;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .source {
            margin-top: 12px;
            color: #727987;
            font-size: 13px;
        }

        .empty {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 35px;
            text-align: center;
        }

        .empty h2 {
            margin-top: 0;
        }

        .empty p {
            color: #9ca3af;
        }

        @media (max-width: 600px) {

            header {
                padding: 0 15px;
            }

            .header-links {
                gap: 10px;
                font-size: 14px;
            }

            main {
                padding: 25px 15px;
            }

            .entry-top {
                flex-direction: column;
            }

        }

    </style>

</head>

<body>

<header>

    <div class="brand">
        Resolve
    </div>

    <div class="header-links">

        <a
            href="/dashboard/server/${encodeURIComponent(guildId)}"
        >
            ← Server Dashboard
        </a>

        <a href="/logout">
            Logout
        </a>

    </div>

</header>

<main>

    <div class="heading">

        <h1>
            🧠 Knowledge
        </h1>

        <p>
            Approved information Resolve can use
            when helping members of this server.
        </p>

    </div>

    ${entryHtml}

</main>

</body>

</html>
            `);

        } catch (error) {

            console.error(
                "❌ Knowledge page error:",
                error
            );

            res
                .status(500)
                .send("Unable to load knowledge.");
        }
    }
);


/* --------------------------------------------------
   TICKET CENTER
-------------------------------------------------- */

app.get(
    "/dashboard/server/:guildId/tickets",
    requireLogin,
    async (req, res) => {

        try {

            const { guildId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            const status = req.query.status || "all";
            const priority = req.query.priority || "all";
            const search = (req.query.search || "").trim();

            const allowedStatuses = [
                "open",
                "human",
                "closed"
            ];

            const allowedPriorities = [
                "low",
                "normal",
                "high",
                "urgent"
            ];

            let where = [
                "guild_id = $1"
            ];

            const values = [
                guildId
            ];

            let parameterNumber = 2;

            if (
                allowedStatuses.includes(status)
            ) {
                where.push(
                    `status = $${parameterNumber}`
                );

                values.push(status);

                parameterNumber++;
            }

            if (
                allowedPriorities.includes(priority)
            ) {
                where.push(
                    `priority = $${parameterNumber}`
                );

                values.push(priority);

                parameterNumber++;
            }

            if (search) {

                where.push(`
                    (
                        CAST(id AS TEXT) ILIKE $${parameterNumber}
                        OR
                        CAST(user_id AS TEXT) ILIKE $${parameterNumber}
                        OR
                        CAST(channel_id AS TEXT) ILIKE $${parameterNumber}
                    )
                `);

                values.push(`%${search}%`);

                parameterNumber++;
            }

            const result = await db.query(
                `
                SELECT
                    id,
                    channel_id,
                    user_id,
                    status,
                    priority,
                    created_at
                FROM tickets
                WHERE ${where.join(" AND ")}
                ORDER BY created_at DESC
                `,
                values
            );

            const tickets = result.rows;

            const ticketHtml = tickets.length
                ? tickets
                    .map((ticket) => {

                        let statusLabel = "Open";

                        if (ticket.status === "human") {
                            statusLabel = "Claimed";
                        }

                        if (ticket.status === "closed") {
                            statusLabel = "Closed";
                        }

                        const priorityValue =
                            ticket.priority || "normal";

                        const priorityEmoji = {
                            low: "🟢",
                            normal: "🔵",
                            high: "🟠",
                            urgent: "🔴"
                        }[priorityValue] || "🔵";

                        return `
                            <a
                                class="ticket"
                                href="/dashboard/server/${encodeURIComponent(
                                    guildId
                                )}/tickets/${encodeURIComponent(
                                    ticket.id
                                )}"
                            >

                                <div class="ticket-main">

                                    <div class="ticket-title">
                                        Ticket #${ticket.id}
                                    </div>

                                    <div class="ticket-info">
                                        User:
                                        ${escapeHtml(ticket.user_id)}
                                    </div>

                                    <div class="ticket-info">
                                        Channel:
                                        ${escapeHtml(
                                            ticket.channel_id
                                        )}
                                    </div>

                                </div>

                                <div class="ticket-right">

                                    <span class="priority">
                                        ${priorityEmoji}
                                        ${escapeHtml(
                                            priorityValue
                                        )}
                                    </span>

                                    <span class="status">
                                        ${statusLabel}
                                    </span>

                                </div>

                            </a>
                        `;
                    })
                    .join("")
                : `
                    <div class="empty">
                        <h2>No tickets found</h2>

                        <p>
                            Try changing your filters or search.
                        </p>
                    </div>
                `;

            res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        Tickets - ${escapeHtml(guild.name)}
    </title>

    <style>

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            background: #0f1117;
            color: white;
            font-family: Arial, sans-serif;
        }

        header {
            height: 70px;
            padding: 0 24px;
            border-bottom: 1px solid #272b36;
            background: #12151c;

            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .brand {
            font-size: 21px;
            font-weight: bold;
        }

        .header-links {
            display: flex;
            gap: 18px;
        }

        .header-links a {
            color: #aeb4c0;
            text-decoration: none;
        }

        main {
            max-width: 1100px;
            margin: 0 auto;
            padding: 35px 22px 60px;
        }

        .heading {
            margin-bottom: 25px;
        }

        .heading h1 {
            margin: 0 0 8px;
            font-size: 32px;
        }

        .heading p {
            margin: 0;
            color: #9ca3af;
        }

        .filters {
            display: grid;
            grid-template-columns:
                1fr 180px 180px auto;

            gap: 10px;
            margin-bottom: 20px;
        }

        .filters input,
        .filters select,
        .filters button {
            min-height: 42px;
            border-radius: 8px;
            border: 1px solid #303542;
            background: #181b24;
            color: white;
            padding: 0 12px;
        }

        .filters button {
            background: #5865f2;
            border: none;
            font-weight: bold;
            cursor: pointer;
        }

        .ticket {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 20px;

            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 13px;

            padding: 18px;
            margin-bottom: 12px;

            color: white;
            text-decoration: none;
        }

        .ticket:hover {
            border-color: #5865f2;
            background: #1b1f29;
        }

        .ticket-title {
            font-weight: bold;
            font-size: 17px;
            margin-bottom: 7px;
        }

        .ticket-info {
            color: #8f96a3;
            font-size: 13px;
            margin-top: 3px;
        }

        .ticket-right {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .priority,
        .status {
            padding: 7px 10px;
            border-radius: 20px;
            background: #252936;
            font-size: 13px;
            white-space: nowrap;
        }

        .status {
            color: #c9cdd5;
        }

        .empty {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 35px;
            text-align: center;
        }

        .empty p {
            color: #9ca3af;
        }

        @media (max-width: 700px) {

            .filters {
                grid-template-columns: 1fr;
            }

            .ticket {
                align-items: flex-start;
                flex-direction: column;
            }

            .ticket-right {
                width: 100%;
                flex-wrap: wrap;
            }

        }

    </style>

</head>

<body>

<header>

    <div class="brand">
        Resolve
    </div>

    <div class="header-links">

        <a
            href="/dashboard/server/${encodeURIComponent(guildId)}"
        >
            ← Server Dashboard
        </a>

        <a href="/logout">
            Logout
        </a>

    </div>

</header>

<main>

    <div class="heading">

        <h1>
            🎫 Ticket Center
        </h1>

        <p>
            Manage support tickets for
            ${escapeHtml(guild.name)}.
        </p>

    </div>

    <form
        class="filters"
        method="GET"
        action="/dashboard/server/${encodeURIComponent(guildId)}/tickets"
    >

        <input
            type="text"
            name="search"
            placeholder="Search ticket, user, or channel ID..."
            value="${escapeHtml(search)}"
        >

        <select name="status">

            <option
                value="all"
                ${status === "all" ? "selected" : ""}
            >
                All statuses
            </option>

            <option
                value="open"
                ${status === "open" ? "selected" : ""}
            >
                Open
            </option>

            <option
                value="human"
                ${status === "human" ? "selected" : ""}
            >
                Claimed
            </option>

            <option
                value="closed"
                ${status === "closed" ? "selected" : ""}
            >
                Closed
            </option>

        </select>

        <select name="priority">

            <option
                value="all"
                ${priority === "all" ? "selected" : ""}
            >
                All priorities
            </option>

            <option
                value="low"
                ${priority === "low" ? "selected" : ""}
            >
                🟢 Low
            </option>

            <option
                value="normal"
                ${priority === "normal" ? "selected" : ""}
            >
                🔵 Normal
            </option>

            <option
                value="high"
                ${priority === "high" ? "selected" : ""}
            >
                🟠 High
            </option>

            <option
                value="urgent"
                ${priority === "urgent" ? "selected" : ""}
            >
                🔴 Urgent
            </option>

        </select>

        <button type="submit">
            Search
        </button>

    </form>

    ${ticketHtml}

</main>

</body>

</html>
            `);

        } catch (error) {

            console.error(
                "❌ Ticket list error:",
                error
            );

            res
                .status(500)
                .send("Unable to load tickets.");
        }
    }
);
/* --------------------------------------------------
   INDIVIDUAL TICKET
-------------------------------------------------- */

app.get(
    "/dashboard/server/:guildId/tickets/:ticketId",
    requireLogin,
    async (req, res) => {
        try {
            const { guildId, ticketId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            const ticketResult = await db.query(
                `
                SELECT
                    id,
                    channel_id,
                    user_id,
                    guild_id,
                    status,
                    priority,
                    created_at
                FROM tickets
                WHERE id = $1
                AND guild_id = $2
                LIMIT 1
                `,
                [ticketId, guildId]
            );

            if (ticketResult.rows.length === 0) {
                return res.status(404).send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >
    <title>Ticket Not Found - Resolve</title>
</head>

<body
    style="
        margin:0;
        background:#0f1117;
        color:white;
        font-family:Arial,sans-serif;
        padding:50px;
    "
>

    <h1>Ticket Not Found</h1>

    <p style="color:#9ca3af;">
        This ticket does not exist or does not belong
        to this server.
    </p>

    <a
        href="/dashboard/server/${encodeURIComponent(guildId)}/tickets"
        style="color:#5865f2;"
    >
        ← Back to Tickets
    </a>

</body>
</html>
                `);
            }

            const ticket = ticketResult.rows[0];

            const messagesResult = await db.query(
                `
                SELECT
                    user_id,
                    content,
                    is_staff,
                    created_at
                FROM ticket_messages
                WHERE ticket_id = $1
                ORDER BY created_at ASC
                `,
                [ticket.id]
            );

            const messages = messagesResult.rows;

            const statusLabel =
                ticket.status === "human"
                    ? "Claimed"
                    : ticket.status === "closed"
                        ? "Closed"
                        : "Open";

            const priorityValue =
                ticket.priority || "normal";

            const priorityEmoji = {
                low: "🟢",
                normal: "🔵",
                high: "🟠",
                urgent: "🔴"
            }[priorityValue] || "🔵";

            const messageHtml = messages.length
                ? messages
                    .map((message) => `
                        <div class="message ${
                            message.is_staff
                                ? "staff"
                                : "member"
                        }">

                            <div class="message-top">

                                <strong>
                                    ${
                                        message.is_staff
                                            ? "🛡️ Support Staff"
                                            : "👤 Member"
                                    }
                                </strong>

                                <span>
                                    ${escapeHtml(
                                        message.user_id
                                    )}
                                </span>

                            </div>

                            <div class="message-content">
                                ${escapeHtml(
                                    message.content
                                )}
                            </div>

                        </div>
                    `)
                    .join("")
                : `
                    <div class="empty">
                        No messages have been recorded
                        for this ticket.
                    </div>
                `;

            const canSaveAnswer =
                ticket.status !== "closed";

            res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        Ticket #${escapeHtml(ticket.id)} - Resolve
    </title>

    <style>

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            background: #0f1117;
            color: white;
            font-family: Arial, sans-serif;
        }

        header {
            min-height: 70px;
            padding: 15px 24px;
            border-bottom: 1px solid #272b36;
            background: #12151c;

            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 15px;
        }

        .brand {
            font-size: 21px;
            font-weight: bold;
        }

        .header-links {
            display: flex;
            align-items: center;
            gap: 18px;
        }

        .header-links a {
            color: #aeb4c0;
            text-decoration: none;
        }

        .header-links a:hover {
            color: white;
        }

        main {
            max-width: 1100px;
            margin: 0 auto;
            padding: 30px 22px 60px;
        }

        .ticket-header {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 22px;
            margin-bottom: 18px;
        }

        .ticket-header-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 20px;
        }

        h1 {
            margin: 0 0 8px;
            font-size: 28px;
        }

        .subtext {
            color: #8f96a3;
            font-size: 14px;
        }

        .badges {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .badge {
            background: #252936;
            border-radius: 20px;
            padding: 7px 11px;
            font-size: 13px;
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 9px;
            margin-top: 20px;
        }

        .actions form {
            margin: 0;
        }

        button {
            border: 0;
            border-radius: 8px;
            padding: 10px 15px;
            color: white;
            font-weight: bold;
            cursor: pointer;
        }

        .claim {
            background: #5865f2;
        }

        .unclaim {
            background: #4b5563;
        }

        .close {
            background: #ed4245;
        }

        .reopen {
            background: #57f287;
            color: #111;
        }

        .conversation {
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 20px;
        }

        .conversation h2 {
            margin-top: 0;
        }

        .message {
            border-radius: 11px;
            padding: 15px;
            margin-bottom: 12px;
            border: 1px solid #292e3a;
        }

        .message.member {
            background: #151820;
        }

        .message.staff {
            background: #1b2130;
            border-color: #39436b;
        }

        .message-top {
            display: flex;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 10px;
            font-size: 13px;
        }

        .message-top span {
            color: #737b8b;
        }

        .message-content {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            color: #d9dce3;
            line-height: 1.6;
        }

        .save-box {
            margin-top: 20px;
            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 14px;
            padding: 20px;
        }

        .save-box h2 {
            margin-top: 0;
        }

        .save-box p {
            color: #9ca3af;
            line-height: 1.5;
        }

        textarea {
            width: 100%;
            min-height: 130px;
            resize: vertical;
            border: 1px solid #303542;
            background: #10131a;
            color: white;
            border-radius: 9px;
            padding: 12px;
            font-family: Arial, sans-serif;
            font-size: 14px;
            outline: none;
        }

        textarea:focus {
            border-color: #5865f2;
        }

        .save-button {
            margin-top: 10px;
            background: #5865f2;
        }

        .disabled-text {
            color: #727987;
            font-size: 14px;
        }

        .empty {
            padding: 25px;
            text-align: center;
            color: #8f96a3;
        }

        @media (max-width: 650px) {

            header {
                align-items: flex-start;
                flex-direction: column;
            }

            .ticket-header-top {
                flex-direction: column;
            }

            main {
                padding: 20px 14px 45px;
            }

            .message-top {
                flex-direction: column;
            }

        }

    </style>

</head>

<body>

<header>

    <div class="brand">
        Resolve
    </div>

    <div class="header-links">

        <a
            href="/dashboard/server/${encodeURIComponent(guildId)}/tickets"
        >
            ← Tickets
        </a>

        <a href="/logout">
            Logout
        </a>

    </div>

</header>

<main>

    <div class="ticket-header">

        <div class="ticket-header-top">

            <div>

                <h1>
                    🎫 Ticket #${escapeHtml(ticket.id)}
                </h1>

                <div class="subtext">
                    User ID:
                    ${escapeHtml(ticket.user_id)}
                    <br>
                    Channel ID:
                    ${escapeHtml(ticket.channel_id)}
                </div>

            </div>

            <div class="badges">

                <span class="badge">
                    ${priorityEmoji}
                    ${escapeHtml(priorityValue)}
                </span>

                <span class="badge">
                    ${statusLabel}
                </span>

            </div>

        </div>

        <div class="actions">

            ${
                ticket.status === "closed"
                    ? `
                        <form
                            method="POST"
                            action="/dashboard/server/${encodeURIComponent(
                                guildId
                            )}/tickets/${encodeURIComponent(
                                ticket.id
                            )}/reopen"
                        >
                            <button
                                class="reopen"
                                type="submit"
                            >
                                Reopen Ticket
                            </button>
                        </form>
                    `
                    : ticket.status === "human"
                        ? `
                            <form
                                method="POST"
                                action="/dashboard/server/${encodeURIComponent(
                                    guildId
                                )}/tickets/${encodeURIComponent(
                                    ticket.id
                                )}/unclaim"
                            >
                                <button
                                    class="unclaim"
                                    type="submit"
                                >
                                    Unclaim
                                </button>
                            </form>
                        `
                        : `
                            <form
                                method="POST"
                                action="/dashboard/server/${encodeURIComponent(
                                    guildId
                                )}/tickets/${encodeURIComponent(
                                    ticket.id
                                )}/claim"
                            >
                                <button
                                    class="claim"
                                    type="submit"
                                >
                                    Claim Ticket
                                </button>
                            </form>
                        `
            }

            ${
                ticket.status !== "closed"
                    ? `
                        <form
                            method="POST"
                            action="/dashboard/server/${encodeURIComponent(
                                guildId
                            )}/tickets/${encodeURIComponent(
                                ticket.id
                            )}/close"
                        >
                            <button
                                class="close"
                                type="submit"
                            >
                                Close Ticket
                            </button>
                        </form>
                    `
                    : ""
            }

        </div>

    </div>

    <div class="conversation">

        <h2>
            Conversation
        </h2>

        ${messageHtml}

    </div>

    ${
        canSaveAnswer
            ? `
                <div class="save-box">

                    <h2>
                        🧠 Save Answer to Knowledge
                    </h2>

                    <p>
                        Save an approved staff answer so
                        Resolve can use it when helping
                        members in the future.
                    </p>

                    <form
                        method="POST"
                        action="/dashboard/server/${encodeURIComponent(
                            guildId
                        )}/tickets/${encodeURIComponent(
                            ticket.id
                        )}/save-answer"
                    >

                        <textarea
                            name="answer"
                            required
                            placeholder="Enter the approved answer that Resolve should remember..."
                        ></textarea>

                        <br>

                        <button
                            class="save-button"
                            type="submit"
                        >
                            Save Approved Answer
                        </button>

                    </form>

                </div>
            `
            : `
                <div class="save-box">

                    <h2>
                        🧠 Knowledge
                    </h2>

                    <p class="disabled-text">
                        This ticket is closed.
                    </p>

                </div>
            `
    }

</main>

</body>

</html>
            `);

        } catch (error) {

            console.error(
                "❌ Ticket details error:",
                error
            );

            res
                .status(500)
                .send("Unable to load this ticket.");
        }
    }
);


/* --------------------------------------------------
   CLAIM TICKET
-------------------------------------------------- */

app.post(
    "/dashboard/server/:guildId/tickets/:ticketId/claim",
    requireLogin,
    async (req, res) => {

        try {

            const { guildId, ticketId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            await db.query(
                `
                UPDATE tickets
                SET status = 'human'
                WHERE id = $1
                AND guild_id = $2
                AND status != 'closed'
                `,
                [ticketId, guildId]
            );

            res.redirect(
                `/dashboard/server/${encodeURIComponent(
                    guildId
                )}/tickets/${encodeURIComponent(
                    ticketId
                )}`
            );

        } catch (error) {

            console.error(
                "❌ Claim ticket error:",
                error
            );

            res.status(500).send(
                "Unable to claim this ticket."
            );
        }
    }
);


/* --------------------------------------------------
   UNCLAIM TICKET
-------------------------------------------------- */

app.post(
    "/dashboard/server/:guildId/tickets/:ticketId/unclaim",
    requireLogin,
    async (req, res) => {

        try {

            const { guildId, ticketId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            await db.query(
                `
                UPDATE tickets
                SET status = 'open'
                WHERE id = $1
                AND guild_id = $2
                AND status = 'human'
                `,
                [ticketId, guildId]
            );

            res.redirect(
                `/dashboard/server/${encodeURIComponent(
                    guildId
                )}/tickets/${encodeURIComponent(
                    ticketId
                )}`
            );

        } catch (error) {

            console.error(
                "❌ Unclaim ticket error:",
                error
            );

            res.status(500).send(
                "Unable to unclaim this ticket."
            );
        }
    }
);


/* --------------------------------------------------
   CLOSE TICKET
-------------------------------------------------- */

app.post(
    "/dashboard/server/:guildId/tickets/:ticketId/close",
    requireLogin,
    async (req, res) => {

        try {

            const { guildId, ticketId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            await db.query(
                `
                UPDATE tickets
                SET status = 'closed'
                WHERE id = $1
                AND guild_id = $2
                AND status != 'closed'
                `,
                [ticketId, guildId]
            );

            res.redirect(
                `/dashboard/server/${encodeURIComponent(
                    guildId
                )}/tickets/${encodeURIComponent(
                    ticketId
                )}`
            );

        } catch (error) {

            console.error(
                "❌ Close ticket error:",
                error
            );

            res.status(500).send(
                "Unable to close this ticket."
            );
        }
    }
);


/* --------------------------------------------------
   REOPEN TICKET
-------------------------------------------------- */

app.post(
    "/dashboard/server/:guildId/tickets/:ticketId/reopen",
    requireLogin,
    async (req, res) => {

        try {

            const { guildId, ticketId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            await db.query(
                `
                UPDATE tickets
                SET status = 'open'
                WHERE id = $1
                AND guild_id = $2
                AND status = 'closed'
                `,
                [ticketId, guildId]
            );

            res.redirect(
                `/dashboard/server/${encodeURIComponent(
                    guildId
                )}/tickets/${encodeURIComponent(
                    ticketId
                )}`
            );

        } catch (error) {

            console.error(
                "❌ Reopen ticket error:",
                error
            );

            res.status(500).send(
                "Unable to reopen this ticket."
            );
        }
    }
);


/* --------------------------------------------------
   SAVE ANSWER
-------------------------------------------------- */

app.post(
    "/dashboard/server/:guildId/tickets/:ticketId/save-answer",
    requireLogin,
    async (req, res) => {

        try {

            const { guildId, ticketId } = req.params;

            const guild = getManageableGuild(req, guildId);

            if (!guild) {
                return res.status(403).send("Access denied.");
            }

            const answer = (req.body.answer || "").trim();

            if (!answer) {
                return res.status(400).send(
                    "Answer cannot be empty."
                );
            }

            const ticketResult = await db.query(
                `
                SELECT
                    id,
                    guild_id
                FROM tickets
                WHERE id = $1
                AND guild_id = $2
                LIMIT 1
                `,
                [ticketId, guildId]
            );

            if (ticketResult.rows.length === 0) {
                return res.status(404).send(
                    "Ticket not found."
                );
            }

            await db.query(
                `
                INSERT INTO knowledge (
                    guild_id,
                    title,
                    content,
                    approved,
                    source_channel_id
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    TRUE,
                    NULL
                )
                `,
                [
                    guildId,
                    `Approved answer from Ticket #${ticketId}`,
                    answer
                ]
            );

            res.redirect(
                `/dashboard/server/${encodeURIComponent(
                    guildId
                )}/tickets/${encodeURIComponent(
                    ticketId
                )}`
            );

        } catch (error) {

            console.error(
                "❌ Save answer error:",
                error
            );

            res.status(500).send(
                "Unable to save this answer."
            );
        }
    }
);
 /* --------------------------------------------------
    ERROR HANDLING
 -------------------------------------------------- */

app.use((req, res) => {
    res.status(404).send(`
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>Page Not Found - Resolve</title>

    <style>
        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            min-height: 100vh;

            display: flex;
            align-items: center;
            justify-content: center;

            background: #0f1117;
            color: white;

            font-family: Arial, sans-serif;
        }

        .box {
            width: 90%;
            max-width: 500px;

            background: #181b24;
            border: 1px solid #292e3a;
            border-radius: 16px;

            padding: 35px;

            text-align: center;
        }

        h1 {
            margin-top: 0;
            font-size: 30px;
        }

        p {
            color: #9ca3af;
            line-height: 1.6;
        }

        a {
            display: inline-block;

            margin-top: 15px;

            padding: 11px 18px;

            border-radius: 8px;

            background: #5865f2;
            color: white;

            text-decoration: none;
            font-weight: bold;
        }

        a:hover {
            background: #4752c4;
        }
    </style>
</head>

<body>

    <div class="box">

        <h1>
            404 — Page Not Found
        </h1>

        <p>
            The page you're looking for doesn't exist
            or may have been moved.
        </p>

        <a href="/dashboard">
            Return to Dashboard
        </a>

    </div>

</body>

</html>
    `);
});


/* --------------------------------------------------
   GLOBAL ERROR HANDLER
-------------------------------------------------- */

app.use((error, req, res, next) => {

    console.error(
        "❌ Unhandled dashboard error:",
        error
    );

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).send(`
<!DOCTYPE html>
<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>Resolve Error</title>

    <style>

        body {
            margin: 0;
            min-height: 100vh;

            display: flex;
            align-items: center;
            justify-content: center;

            background: #0f1117;
            color: white;

            font-family: Arial, sans-serif;
        }

        .box {
            width: 90%;
            max-width: 500px;

            background: #181b24;

            border: 1px solid #292e3a;
            border-radius: 16px;

            padding: 35px;

            text-align: center;
        }

        h1 {
            margin-top: 0;
        }

        p {
            color: #9ca3af;
            line-height: 1.6;
        }

        a {
            color: #5865f2;
            text-decoration: none;
        }

    </style>

</head>

<body>

    <div class="box">

        <h1>
            Something went wrong
        </h1>

        <p>
            Resolve encountered an unexpected error
            while loading this page.
        </p>

        <a href="/dashboard">
            Return to Dashboard
        </a>

    </div>

</body>

</html>
    `);
});
app.listen(PORT, () => {
    console.log(
        `🚀 Resolve Dashboard running on port ${PORT}`
    );
});