# Instagram Media Bot for Telegram 🎥

A Telegram bot that automatically downloads and sends Instagram reels, posts, videos, and clips when links are shared in your group chats or private messages.

Built with [instagrapi](https://github.com/subzeroid/instagrapi) - a fast and effective Instagram Private API wrapper.

## ✨ Features

- 🔗 Automatic detection of Instagram links (reels, posts, videos, clips)
- 📥 Downloads and sends videos directly to Telegram
- 🔐 Persistent session management with automatic reuse
- 👥 Works in both groups and private chats
- 🚀 Fast and reliable using official `instagrapi` best practices
- 💾 Session persistence across restarts with UUID preservation
- 📦 Support for albums/carousels (downloads first video)
- 🎬 Support for Reels clips with proper detection

## 🆕 What's New

This bot now uses **instagrapi** instead of yt-dlp, following official best practices, which means:

✅ No more cookie management  
✅ No more expired cookies errors  
✅ Persistent login sessions with automatic reuse  
✅ More reliable downloads via Instagram Private API  
✅ Better error handling and recovery  
✅ Device UUID preservation across logins  
✅ Proper session validation and re-authentication

## 📋 Prerequisites

- Python 3.8 or higher
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- An Instagram account (create a dedicated account, don't use your personal one!)

## 🚀 Quick Start

### 1. Clone the repository

```bash
git clone <repository-url>
cd instalink-bot
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

Or if you're using a virtual environment (recommended):

```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Configure environment variables

Copy the example environment file:

```bash
cp env.example .env
```

Edit `.env` and fill in your credentials:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
INSTAGRAM_USERNAME=your_instagram_username
INSTAGRAM_PASSWORD=your_instagram_password
```

⚠️ **Important**: 
- Use a **dedicated Instagram account** for the bot, not your personal account
- Instagram may flag automated access on personal accounts
- Consider creating a new account specifically for this bot

### 4. Run the bot

```bash
python main.py
```

On first run, the bot will:
1. Log in to Instagram using your credentials
2. Save the session settings (including device UUIDs) to `instagram_session.json`
3. Start listening for Instagram links

On subsequent runs:
1. Load existing session from `instagram_session.json`
2. Verify session is still valid
3. Auto re-login if session expired (preserving device UUIDs)
4. Continue listening for Instagram links

## 🎯 Usage

### In Telegram

1. Add the bot to your group chat or message it directly
2. Share an Instagram link (reel, post, or video)
3. The bot will automatically download and send the video!

### Supported URL formats

- `https://www.instagram.com/reel/ABC123/` (Reels)
- `https://instagram.com/reels/ABC123/` (Reels)
- `https://www.instagram.com/p/ABC123/` (Video posts and albums)

### Bot Commands

- `/start` - Welcome message and bot introduction
- `/help` - Show help and usage instructions
- `/status` - Check if the bot is logged in to Instagram
- `/login` - Force re-login to Instagram (if session expires)

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token from BotFather | - | ✅ Yes |
| `INSTAGRAM_USERNAME` | Instagram account username | - | ✅ Yes |
| `INSTAGRAM_PASSWORD` | Instagram account password | - | ✅ Yes |
| `DOWNLOAD_DIR` | Directory for temporary downloads | `./downloads` | ❌ No |
| `SESSION_FILE` | Path to session file | `./instagram_session.json` | ❌ No |

## 🛡️ Security Best Practices

1. **Never commit your `.env` file** - It contains sensitive credentials
2. **Use a dedicated Instagram account** - Don't use your personal account
3. **Enable 2FA on your bot's Telegram account** (optional but recommended)
4. **Keep your session file secure** - It contains your Instagram login session
5. **Run the bot on a secure server** - Use proper firewall and access controls

## 📁 File Structure

```
instalink-bot/
├── main.py                      # Main bot application
├── requirements.txt             # Python dependencies
├── .env                         # Environment variables (create this!)
├── env.example                  # Example environment file
├── instagram_session.json       # Instagram session (auto-generated)
├── downloads/                   # Temporary download directory
└── README.md                    # This file
```

## 🐛 Troubleshooting

### Bot won't log in to Instagram

**Problem**: Login fails with challenge or error

**Solutions**:
1. Check that your Instagram username and password are correct
2. Instagram may require verification - check your email/phone
3. Try logging in manually to the Instagram account first
4. Wait a few minutes and try again (rate limiting)
5. Use a fresh Instagram account that hasn't been flagged
6. Delete `instagram_session.json` and try again
7. Check bot logs for specific error messages

**Note**: The bot uses instagrapi's recommended login flow with session reuse and UUID preservation.

### Session expires frequently

**Problem**: Bot keeps asking to login

**Solutions**:
1. Don't use the same Instagram account on multiple devices simultaneously
2. Avoid logging into the account manually while the bot is running
3. Check if Instagram has sent you a security alert
4. Delete `instagram_session.json` and run `/login` command
5. The bot preserves device UUIDs across logins to appear more natural to Instagram

**Note**: Following instagrapi best practices, the bot reuses session settings and device identifiers to minimize re-authentication.

### Videos not downloading

**Problem**: Bot detects links but can't download videos

**Solutions**:
1. Check `/status` to ensure the bot is logged in
2. The post might be private (bot can't access private posts)
3. The post might be a photo, not a video
4. Instagram might be rate limiting - wait a few minutes
5. Try `/login` to force a fresh login
6. For albums/carousels, the bot sends the first video found
7. Check bot logs for specific error messages (VideoNotDownload, etc.)

### "Please wait a few minutes"

**Problem**: Instagram rate limiting

**Solutions**:
1. Wait 5-10 minutes before trying again
2. Don't spam links - Instagram monitors bot-like behavior
3. Consider using Instagram less frequently
4. This is Instagram's protection against abuse
5. The bot uses `delay_range = [1, 3]` seconds between requests to appear more natural

**Technical Note**: The bot follows instagrapi's recommended practices to minimize rate limiting.

## 🚀 Running on a Server

### Using systemd (Linux)

Create a service file `/etc/systemd/system/instalink-bot.service`:

```ini
[Unit]
Description=Instagram Reel Telegram Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/instalink-bot
Environment="PATH=/path/to/instalink-bot/venv/bin"
ExecStart=/path/to/instalink-bot/venv/bin/python main.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable instalink-bot
sudo systemctl start instalink-bot
sudo systemctl status instalink-bot
```

### Using Docker (coming soon)

Docker support is planned for easier deployment.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## ⚠️ Disclaimer

This bot is for educational purposes. Use responsibly and respect Instagram's Terms of Service. The developers are not responsible for any misuse or violations of Instagram's policies.

**Implementation Details**: This bot follows the [official instagrapi best practices](https://github.com/subzeroid/instagrapi/blob/master/docs/usage-guide/best-practices.md) including:
- Session reuse with validation
- Device UUID preservation across logins
- Proper error handling for challenges and rate limits
- Natural request delays

## 🙏 Acknowledgments

- [python-telegram-bot](https://github.com/python-telegram-bot/python-telegram-bot) - Telegram Bot API wrapper
- [instagrapi](https://github.com/subzeroid/instagrapi) by [@subzeroid](https://github.com/subzeroid) - Instagram Private API wrapper
- [python-dotenv](https://github.com/theskumar/python-dotenv) - Environment variable management

Special thanks to the instagrapi project for providing excellent documentation and best practices for Instagram API integration.

## 📞 Support

If you encounter any issues or have questions:

1. Check the [Troubleshooting](#-troubleshooting) section
2. Review existing issues on GitHub
3. Create a new issue with details about your problem

---

Made with ❤️ for the Telegram community