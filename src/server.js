require("dotenv").config();

const express = require("express");
const session = require("express-session");
const db = require("./database/db");

const app = express();
const PORT = process.env.PORT || 3000;

// =================================
// APP CONFIG
// =================================

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
    session({
        secret: process.env.SESSION_SECRET || "resolve-dashboard-secret",
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false,
            maxAge: 1000 * 60 * 60 * 24
        }
    })
);

// =================================
// DISCORD CONFIG
// =================================

const DISCORD_API = "https://discord.com/api/v10";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const REDIRECT_URI =
    process.env.REDIRECT_URI ||
    "https://resolve-dashboard.onrender.com/auth/discord/callback";

// =================================
// AUTH
// =================================

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect("/");
    }

    next();
}

// =================================
// SERVER ACCESS
// =================================

function getManageableGuild(req, guildId) {
    const guilds = req.session.guilds || [];

    const guild = guilds.find(
        (server) => server.id === guildId
    );

    if (!guild) {
        return null;
    }

    try {
        const permissions = BigInt(guild.permissions);

        const isAdmin =
            (permissions & 0x8n) === 0x8n;

        const canManageServer =
            (permissions & 0x20n) === 0x20n;

        if (!isAdmin && !canManageServer) {
            return null;
        }

        return guild;
    } catch {
        return null;
    }
}

// =================================
// HTML ESCAPE
// =================================

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// =================================
// HOME
// =================================

app.get("/", (req, res) => {
    res.render("index");
});

// =================================
// DISCORD LOGIN
// =================================

app.get("/auth/discord", (req, res) => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        return res.status(500).send(`
            <h1>Resolve Dashboard Error</h1>
            <p>CLIENT_ID or CLIENT_SECRET is missing from .env</p>
        `);
    }

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

// =================================
// DISCORD CALLBACK
// =================================

app.get("/auth/discord/callback", async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send("Missing Discord OAuth code.");
    }

    try {
        const tokenResponse = await fetch(
            `${DISCORD_API}/oauth2/token`,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: REDIRECT_URI
                })
            }
        );

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok) {
            console.error(
                "Discord token error:",
                tokenData
            );

            return res.status(500).send(`
                <h1>Discord Login Failed</h1>
                <p>Could not exchange the OAuth code.</p>
                <a href="/">Return to Resolve</a>
            `);
        }

        const accessToken = tokenData.access_token;

        // -----------------------------
        // GET DISCORD USER
        // -----------------------------

        const userResponse = await fetch(
            `${DISCORD_API}/users/@me`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        const user = await userResponse.json();

        if (!userResponse.ok) {
            return res.status(500).send(
                "Could not retrieve your Discord account."
            );
        }

        // -----------------------------
        // GET DISCORD SERVERS
        // -----------------------------

        const guildResponse = await fetch(
            `${DISCORD_API}/users/@me/guilds`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        const guilds = await guildResponse.json();

        if (!guildResponse.ok) {
            return res.status(500).send(
                "Could not retrieve your Discord servers."
            );
        }

        req.session.user = user;
        req.session.guilds = guilds;
        req.session.accessToken = accessToken;

        console.log(
            `✅ Discord login: ${user.username} (${user.id})`
        );

        res.redirect("/dashboard");

    } catch (error) {
        console.error("OAuth error:", error);

        res.status(500).send(`
            <h1>Something went wrong</h1>
            <p>Unable to complete Discord login.</p>
            <a href="/">Return to Resolve</a>
        `);
    }
});

// =================================
// SERVER SELECTION
// =================================

app.get("/dashboard", requireLogin, (req, res) => {
    const user = req.session.user;
    const guilds = req.session.guilds || [];

    const manageableGuilds = guilds.filter((guild) => {
        try {
            const permissions = BigInt(guild.permissions);

            const isAdmin =
                (permissions & 0x8n) === 0x8n;

            const canManageServer =
                (permissions & 0x20n) === 0x20n;

            return isAdmin || canManageServer;
        } catch {
            return false;
        }
    });

    const userAvatar = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

    res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Servers | Resolve</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    min-height: 100vh;
    color: #f5f7ff;
    font-family: Inter, Arial, sans-serif;

    background:
        radial-gradient(
            circle at 10% 10%,
            rgba(124, 92, 255, 0.22),
            transparent 35%
        ),
        radial-gradient(
            circle at 90% 80%,
            rgba(0, 200, 255, 0.12),
            transparent 35%
        ),
        #0b0d16;
}

.navbar {
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: space-between;

    padding: 0 32px;

    background: rgba(17, 20, 34, 0.85);
    border-bottom: 1px solid rgba(255,255,255,0.08);

    backdrop-filter: blur(18px);
}

.brand {
    font-size: 25px;
    font-weight: 800;
    letter-spacing: -1px;
}

.brand span {
    background: linear-gradient(
        135deg,
        #8b7cff,
        #5de0ff
    );

    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.user-area {
    display: flex;
    align-items: center;
    gap: 12px;
}

.avatar {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    border: 2px solid rgba(139,124,255,0.7);
}

.username {
    color: #cbd0e0;
    font-size: 14px;
}

.logout {
    margin-left: 12px;
    padding: 8px 13px;

    color: #ff8f9a;
    text-decoration: none;

    border-radius: 8px;
}

.logout:hover {
    background: rgba(255,80,100,0.1);
}

.container {
    max-width: 1150px;
    margin: auto;
    padding: 55px 25px;
}

.eyebrow {
    color: #8f82ff;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 10px;
}

h1 {
    margin: 0;
    font-size: 42px;
    letter-spacing: -1.5px;
}

.subtitle {
    color: #969db2;
    margin-top: 10px;
    margin-bottom: 38px;
}

.server-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
}

.server {
    position: relative;
    overflow: hidden;

    background: rgba(21, 24, 40, 0.9);

    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px;

    padding: 23px;

    color: white;
    text-decoration: none;

    transition:
        transform 0.2s,
        border-color 0.2s,
        box-shadow 0.2s;
}

.server:hover {
    transform: translateY(-5px);

    border-color: rgba(139,124,255,0.65);

    box-shadow:
        0 15px 40px rgba(0,0,0,0.3),
        0 0 25px rgba(124,92,255,0.1);
}

.server-top {
    display: flex;
    align-items: center;
    gap: 15px;
}

.server-icon {
    width: 62px;
    height: 62px;
    border-radius: 17px;
    object-fit: cover;
}

.server-icon-placeholder {
    width: 62px;
    height: 62px;

    border-radius: 17px;

    display: flex;
    align-items: center;
    justify-content: center;

    font-size: 25px;
    font-weight: 800;

    background:
        linear-gradient(
            135deg,
            #7c5cff,
            #4fc9ff
        );
}

.server-name {
    font-size: 18px;
    font-weight: 700;
    word-break: break-word;
}

.server-status {
    margin-top: 20px;
    color: #62e6a8;
    font-size: 13px;
    font-weight: 600;
}

.empty {
    padding: 45px;
    text-align: center;

    background: rgba(21,24,40,0.9);

    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px;

    color: #9ca3b8;
}

@media (max-width: 850px) {
    .server-grid {
        grid-template-columns: repeat(2, 1fr);
    }
}

@media (max-width: 600px) {

    .server-grid {
        grid-template-columns: 1fr;
    }

    .navbar {
        padding: 0 18px;
    }

    .username {
        display: none;
    }

    .container {
        padding: 40px 18px;
    }

    h1 {
        font-size: 34px;
    }
}

</style>

</head>

<body>

<nav class="navbar">

    <div class="brand">
        <span>R</span>esolve
    </div>

    <div class="user-area">

        <img
            class="avatar"
            src="${userAvatar}"
            alt="Discord Avatar"
        >

        <span class="username">
            ${escapeHtml(user.global_name || user.username)}
        </span>

        <a class="logout" href="/logout">
            Logout
        </a>

    </div>

</nav>

<main class="container">

    <div class="eyebrow">
        Resolve Dashboard
    </div>

    <h1>
        Choose a server
    </h1>

    <div class="subtitle">
        Select a Discord server you have permission to manage.
    </div>

    ${
        manageableGuilds.length === 0
            ? `
                <div class="empty">

                    <h2>
                        No manageable servers found
                    </h2>

                    <p>
                        You need Administrator or Manage Server
                        permission to configure Resolve.
                    </p>

                </div>
            `
            : `
                <div class="server-grid">

                    ${manageableGuilds.map((guild) => {

                        const icon = guild.icon
                            ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
                            : null;

                        return `
                            <a
                                class="server"
                                href="/dashboard/server/${guild.id}"
                            >

                                <div class="server-top">

                                    ${
                                        icon
                                            ? `
                                                <img
                                                    class="server-icon"
                                                    src="${icon}"
                                                    alt=""
                                                >
                                            `
                                            : `
                                                <div class="server-icon-placeholder">
                                                    ${escapeHtml(
                                                        guild.name
                                                            .charAt(0)
                                                            .toUpperCase()
                                                    )}
                                                </div>
                                            `
                                    }

                                    <div class="server-name">
                                        ${escapeHtml(guild.name)}
                                    </div>

                                </div>

                                <div class="server-status">
                                    ✓ You can manage this server
                                </div>

                            </a>
                        `;

                    }).join("")}

                </div>
            `
    }

</main>

</body>

</html>
    `);
});

// =================================
// SERVER DASHBOARD
// =================================

app.get(
    "/dashboard/server/:guildId",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <p>
                    You do not have permission to manage this server.
                </p>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        let settings = null;

        try {
            const result = await db.query(
                `
                SELECT *
                FROM guild_settings
                WHERE guild_id = $1
                LIMIT 1
                `,
                [guildId]
            );

            settings = result.rows[0] || null;

        } catch (error) {

            console.error(
                "❌ Failed to load server settings:",
                error.message
            );
        }

        res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>${escapeHtml(guild.name)} | Resolve</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    min-height: 100vh;

    color: #f5f7ff;

    font-family: Inter, Arial, sans-serif;

    background:
        radial-gradient(
            circle at 10% 10%,
            rgba(124,92,255,0.22),
            transparent 35%
        ),
        radial-gradient(
            circle at 90% 80%,
            rgba(0,200,255,0.10),
            transparent 35%
        ),
        #0b0d16;
}

.navbar {
    height: 72px;

    display: flex;
    align-items: center;

    padding: 0 30px;

    background: rgba(17,20,34,0.85);

    border-bottom:
        1px solid rgba(255,255,255,0.08);

    backdrop-filter: blur(18px);
}

.brand {
    font-size: 25px;
    font-weight: 800;
}

.brand span {
    background:
        linear-gradient(
            135deg,
            #8b7cff,
            #5de0ff
        );

    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.container {
    max-width: 1150px;
    margin: auto;
    padding: 45px 25px;
}

.back {
    color: #969db2;
    text-decoration: none;

    display: inline-block;

    margin-bottom: 25px;
}

.back:hover {
    color: white;
}

.server-title {
    display: flex;
    align-items: center;
    gap: 18px;

    margin-bottom: 8px;
}

.server-title h1 {
    margin: 0;

    font-size: 38px;
    letter-spacing: -1px;
}

.server-title-icon {
    width: 58px;
    height: 58px;

    border-radius: 16px;

    object-fit: cover;
}

.subtitle {
    color: #969db2;
    margin-bottom: 38px;
}

.grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
}

.card {
    position: relative;
    overflow: hidden;

    min-height: 190px;

    background:
        linear-gradient(
            145deg,
            rgba(26,30,50,0.96),
            rgba(18,21,36,0.96)
        );

    border:
        1px solid rgba(255,255,255,0.08);

    border-radius: 18px;

    padding: 25px;

    color: white;
    text-decoration: none;

    transition:
        transform 0.2s,
        border-color 0.2s,
        box-shadow 0.2s;
}

.card:hover {
    transform: translateY(-5px);

    border-color:
        rgba(139,124,255,0.6);

    box-shadow:
        0 15px 35px rgba(0,0,0,0.3),
        0 0 25px rgba(124,92,255,0.08);
}

.card-icon {
    font-size: 31px;
    margin-bottom: 20px;
}

.card h2 {
    margin: 0 0 9px;
    font-size: 20px;
}

.card p {
    margin: 0;

    color: #9299ae;

    line-height: 1.5;

    font-size: 14px;
}

.card-arrow {
    position: absolute;

    right: 20px;
    bottom: 20px;

    color: #777f99;

    font-size: 18px;
}

.status {
    margin-top: 30px;

    padding: 18px 20px;

    background:
        rgba(98,230,168,0.06);

    border:
        1px solid rgba(98,230,168,0.15);

    border-radius: 14px;

    color: #62e6a8;

    font-size: 14px;
}

@media (max-width: 850px) {
    .grid {
        grid-template-columns: repeat(2, 1fr);
    }
}

@media (max-width: 600px) {

    .grid {
        grid-template-columns: 1fr;
    }

    .container {
        padding: 35px 18px;
    }

    .server-title h1 {
        font-size: 30px;
    }
}

</style>

</head>

<body>

<nav class="navbar">

    <div class="brand">
        <span>R</span>esolve
    </div>

</nav>

<main class="container">

    <a class="back" href="/dashboard">
        ← Back to servers
    </a>

    <div class="server-title">

        ${
            guild.icon
                ? `
                    <img
                        class="server-title-icon"
                        src="https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128"
                    >
                `
                : ""
        }

        <h1>
            ${escapeHtml(guild.name)}
        </h1>

    </div>

    <div class="subtitle">
        Manage how Resolve works in this server.
    </div>

    <div class="grid">

        <a
            class="card"
            href="/dashboard/server/${guild.id}/knowledge"
        >

            <div class="card-icon">
                🧠
            </div>

            <h2>
                Knowledge
            </h2>

            <p>
                Manage the approved information
                Resolve uses to answer members.
            </p>

            <div class="card-arrow">
                →
            </div>

        </a>

        <a class="card" href="#">

            <div class="card-icon">
                🎫
            </div>

            <h2>
                Tickets
            </h2>

            <p>
                Configure ticket channels,
                priorities, and ticket behavior.
            </p>

            <div class="card-arrow">
                →
            </div>

        </a>

        <a class="card" href="#">

            <div class="card-icon">
                🤖
            </div>

            <h2>
                AI Settings
            </h2>

            <p>
                Control Resolve's AI support
                and response behavior.
            </p>

            <div class="card-arrow">
                →
            </div>

        </a>

        <a class="card" href="#">

            <div class="card-icon">
                🛡️
            </div>

            <h2>
                Support Team
            </h2>

            <p>
                Configure the role used by your
                support staff.
            </p>

            <div class="card-arrow">
                →
            </div>

        </a>

        <a class="card" href="#">

            <div class="card-icon">
                📊
            </div>

            <h2>
                Analytics
            </h2>

            <p>
                View ticket activity,
                AI usage, and support statistics.
            </p>

            <div class="card-arrow">
                →
            </div>

        </a>

        <a class="card" href="#">

            <div class="card-icon">
                ⚙️
            </div>

            <h2>
                Server Settings
            </h2>

            <p>
                Configure Resolve for this
                Discord server.
            </p>

            <div class="card-arrow">
                →
            </div>

        </a>

    </div>

    <div class="status">
        ● Resolve dashboard connected to your server configuration.
    </div>

</main>

</body>

</html>
        `);
    }
);

// =================================
// KNOWLEDGE — VIEW
// =================================

app.get(
    "/dashboard/server/:guildId/knowledge",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        try {

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

            res.render("knowledge", {
                guild,
                knowledge: result.rows
            });

        } catch (error) {

            console.error(
                "❌ Failed to load knowledge:",
                error.message
            );

            res.status(500).send(`
                <h1>Database Error</h1>

                <p>
                    Could not load Resolve knowledge.
                </p>

                <a href="/dashboard/server/${guildId}">
                    Back to server
                </a>
            `);
        }
    }
);

// =================================
// KNOWLEDGE — ADD
// =================================

app.post(
    "/dashboard/server/:guildId/knowledge",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        const title = String(
            req.body.title || ""
        ).trim();

        const content = String(
            req.body.content || ""
        ).trim();

        if (!title || !content) {
            return res.status(400).send(`
                <h1>Invalid Knowledge</h1>

                <p>
                    Title and content are required.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }

        if (title.length > 200) {
            return res.status(400).send(`
                <h1>Invalid Title</h1>

                <p>
                    Knowledge titles must be 200 characters or less.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }

        try {

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
                    title,
                    content
                ]
            );

            console.log(
                `🧠 Knowledge added to ${guild.name}: ${title}`
            );

            res.redirect(
                `/dashboard/server/${guildId}/knowledge`
            );

        } catch (error) {

            console.error(
                "❌ Failed to add knowledge:",
                error.message
            );

            res.status(500).send(`
                <h1>Database Error</h1>

                <p>
                    Could not save this knowledge entry.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }
    }
);

// =================================
// KNOWLEDGE — EDIT
// =================================

app.post(
    "/dashboard/server/:guildId/knowledge/:knowledgeId/edit",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;
        const knowledgeId = req.params.knowledgeId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        const title = String(
            req.body.title || ""
        ).trim();

        const content = String(
            req.body.content || ""
        ).trim();

        if (!title || !content) {
            return res.status(400).send(`
                <h1>Invalid Knowledge</h1>

                <p>
                    Title and content are required.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }

        try {

            const result = await db.query(
                `
                UPDATE knowledge
                SET
                    title = $1,
                    content = $2
                WHERE
                    id = $3
                    AND guild_id = $4
                RETURNING id
                `,
                [
                    title,
                    content,
                    knowledgeId,
                    guildId
                ]
            );

            if (result.rowCount === 0) {
                return res.status(404).send(`
                    <h1>Knowledge Not Found</h1>

                    <p>
                        That knowledge entry does not exist
                        in this server.
                    </p>

                    <a href="/dashboard/server/${guildId}/knowledge">
                        Back to knowledge
                    </a>
                `);
            }

            console.log(
                `✏️ Knowledge ${knowledgeId} edited in ${guild.name}`
            );

            res.redirect(
                `/dashboard/server/${guildId}/knowledge`
            );

        } catch (error) {

            console.error(
                "❌ Failed to edit knowledge:",
                error.message
            );

            res.status(500).send(`
                <h1>Database Error</h1>

                <p>
                    Could not update this knowledge entry.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }
    }
);

// =================================
// KNOWLEDGE — DELETE
// =================================

app.post(
    "/dashboard/server/:guildId/knowledge/:knowledgeId/delete",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;
        const knowledgeId = req.params.knowledgeId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        try {

            const result = await db.query(
                `
                DELETE FROM knowledge
                WHERE
                    id = $1
                    AND guild_id = $2
                RETURNING id, title
                `,
                [
                    knowledgeId,
                    guildId
                ]
            );

            if (result.rowCount === 0) {
                return res.status(404).send(`
                    <h1>Knowledge Not Found</h1>

                    <p>
                        That knowledge entry does not exist
                        in this server.
                    </p>

                    <a href="/dashboard/server/${guildId}/knowledge">
                        Back to knowledge
                    </a>
                `);
            }

            console.log(
                `🗑️ Knowledge deleted from ${guild.name}: ${result.rows[0].title}`
            );

            res.redirect(
                `/dashboard/server/${guildId}/knowledge`
            );

        } catch (error) {

            console.error(
                "❌ Failed to delete knowledge:",
                error.message
            );

            res.status(500).send(`
                <h1>Database Error</h1>

                <p>
                    Could not delete this knowledge entry.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }
    }
);

// =================================
// KNOWLEDGE — TOGGLE APPROVAL
// =================================

app.post(
    "/dashboard/server/:guildId/knowledge/:knowledgeId/toggle-approved",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;
        const knowledgeId = req.params.knowledgeId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        try {

            const result = await db.query(
                `
                UPDATE knowledge
                SET approved = NOT approved
                WHERE
                    id = $1
                    AND guild_id = $2
                RETURNING id, title, approved
                `,
                [
                    knowledgeId,
                    guildId
                ]
            );

            if (result.rowCount === 0) {
                return res.status(404).send(`
                    <h1>Knowledge Not Found</h1>

                    <a href="/dashboard/server/${guildId}/knowledge">
                        Back to knowledge
                    </a>
                `);
            }

            console.log(
                `🔄 Knowledge ${knowledgeId} approval changed to ${result.rows[0].approved} in ${guild.name}`
            );

            res.redirect(
                `/dashboard/server/${guildId}/knowledge`
            );

        } catch (error) {

            console.error(
                "❌ Failed to toggle knowledge approval:",
                error.message
            );

            res.status(500).send(`
                <h1>Database Error</h1>

                <p>
                    Could not change the approval status.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }
    }
);

// =================================
// KNOWLEDGE — BULK DELETE
// =================================

app.post(
    "/dashboard/server/:guildId/knowledge/bulk-delete",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        let ids = req.body.ids || [];

        if (!Array.isArray(ids)) {
            ids = [ids];
        }

        ids = ids
            .map((id) => String(id).trim())
            .filter((id) => /^\d+$/.test(id));

        if (ids.length === 0) {
            return res.redirect(
                `/dashboard/server/${guildId}/knowledge`
            );
        }

        try {

            const result = await db.query(
                `
                DELETE FROM knowledge
                WHERE
                    guild_id = $1
                    AND id = ANY($2::int[])
                RETURNING id, title
                `,
                [
                    guildId,
                    ids
                ]
            );

            console.log(
                `🗑️ Bulk deleted ${result.rowCount} knowledge entries from ${guild.name}`
            );

            res.redirect(
                `/dashboard/server/${guildId}/knowledge`
            );

        } catch (error) {

            console.error(
                "❌ Failed to bulk delete knowledge:",
                error.message
            );

            res.status(500).send(`
                <h1>Database Error</h1>

                <p>
                    Could not delete the selected knowledge entries.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }
    }
);

// =================================
// KNOWLEDGE — DELETE ALL
// =================================

app.post(
    "/dashboard/server/:guildId/knowledge/delete-all",
    requireLogin,
    async (req, res) => {

        const guildId = req.params.guildId;

        const guild = getManageableGuild(
            req,
            guildId
        );

        if (!guild) {
            return res.status(403).send(`
                <h1>Access Denied</h1>
                <a href="/dashboard">
                    Back to servers
                </a>
            `);
        }

        try {

            const result = await db.query(
                `
                DELETE FROM knowledge
                WHERE guild_id = $1
                RETURNING id, title
                `,
                [guildId]
            );

            console.log(
                `🗑️ Deleted ALL knowledge (${result.rowCount} entries) from ${guild.name}`
            );

            res.redirect(
                `/dashboard/server/${guildId}/knowledge`
            );

        } catch (error) {

            console.error(
                "❌ Failed to delete all knowledge:",
                error.message
            );

            res.status(500).send(`
                <h1>Database Error</h1>

                <p>
                    Could not delete all knowledge entries.
                </p>

                <a href="/dashboard/server/${guildId}/knowledge">
                    Back to knowledge
                </a>
            `);
        }
    }
);

// =================================
// LOGOUT
// =================================

app.get("/logout", (req, res) => {

    req.session.destroy((error) => {

        if (error) {
            console.error(
                "❌ Logout error:",
                error.message
            );
        }

        res.redirect("/");
    });

});

// =================================
// START SERVER
// =================================

app.listen(PORT, () => {

    console.log("=================================");
    console.log("🚀 Resolve Dashboard");
    console.log(`🌐 http://localhost:${PORT}`);
    console.log("🗄️ PostgreSQL enabled");
    console.log("🧠 Knowledge management enabled");
    console.log("=================================");

});