<?php
// Copy to private/config.php and fill in your hosting database + Discord OAuth values.
return [
    'db_host' => 'localhost',
    'db_name' => 'YOUR_MYSQL_DATABASE',
    'db_user' => 'YOUR_MYSQL_USERNAME',
    'db_pass' => 'YOUR_MYSQL_PASSWORD',
    'base_url' => 'https://YOUR-DOMAIN.example',
    'discord_client_id' => '',
    'discord_client_secret' => '',
    'discord_redirect_uri' => 'https://YOUR-DOMAIN.example/auth/discord/callback',
    'discord_guild_id' => '',
    'bootstrap_discord_user_id' => '',
    'session_secret' => 'REPLACE_WITH_A_LONG_RANDOM_SECRET',
    'bot_api_secret' => 'SET_THE_SAME_LONG_RANDOM_SECRET_AS_DISCORD_BOT_ENV',
    'timezone' => 'Africa/Cairo',
];
