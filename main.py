import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from instagrapi import Client
from instagrapi.exceptions import (
    ChallengeRequired,
    ClientError,
    LoginRequired,
    PleaseWaitFewMinutes,
    VideoNotDownload,
)
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# Configuration
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
INSTAGRAM_USERNAME = os.getenv("INSTAGRAM_USERNAME")
INSTAGRAM_PASSWORD = os.getenv("INSTAGRAM_PASSWORD")
DOWNLOAD_DIR = os.getenv("DOWNLOAD_DIR", "./downloads")
SESSION_FILE = os.getenv("SESSION_FILE", "./instagram_session.json")

# Instagram URL patterns
INSTAGRAM_MEDIA_PATTERN = re.compile(
    r"https?://(?:www\.)?instagram\.com/(?:p|reel|reels)/([A-Za-z0-9_-]+)/?",
    re.IGNORECASE,
)


class InstagramDownloader:
    """Handles Instagram media downloads using instagrapi with best practices"""

    def __init__(self, download_dir: str, session_file: str):
        self.download_dir = Path(download_dir)
        self.download_dir.mkdir(exist_ok=True)
        self.session_file = session_file
        self.client = None
        self._login_lock = asyncio.Lock()
        self._is_logged_in = False

    async def _login_user(self):
        """
        Login to Instagram following instagrapi best practices.
        Attempts to reuse existing session first, then falls back to username/password.
        Based on: https://github.com/subzeroid/instagrapi/blob/master/docs/usage-guide/best-practices.md
        """
        self.client = Client()
        self.client.delay_range = [1, 3]

        login_via_session = False
        login_via_pw = False

        # Try to load existing session
        if os.path.exists(self.session_file):
            try:
                logger.info(f"Loading session from {self.session_file}")
                session = self.client.load_settings(self.session_file)

                if session:
                    self.client.set_settings(session)
                    self.client.login(INSTAGRAM_USERNAME, INSTAGRAM_PASSWORD)

                    # Verify session is valid
                    try:
                        loop = asyncio.get_event_loop()
                        await loop.run_in_executor(None, self.client.get_timeline_feed)
                        logger.info("✅ Session loaded and verified successfully")
                        login_via_session = True
                    except LoginRequired:
                        logger.info(
                            "Session is invalid, need to login via username and password"
                        )

                        # Preserve device UUIDs across logins
                        old_session = self.client.get_settings()
                        self.client.set_settings({})
                        self.client.set_uuids(old_session["uuids"])

                        loop = asyncio.get_event_loop()
                        await loop.run_in_executor(
                            None,
                            self.client.login,
                            INSTAGRAM_USERNAME,
                            INSTAGRAM_PASSWORD,
                        )
                        login_via_session = True
            except Exception as e:
                logger.info(f"Couldn't login user using session information: {e}")

        # If session login failed, try username/password
        if not login_via_session:
            try:
                if not INSTAGRAM_USERNAME or not INSTAGRAM_PASSWORD:
                    logger.error(
                        "INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set"
                    )
                    return False

                logger.info(
                    f"Attempting to login via username and password. username: {INSTAGRAM_USERNAME}"
                )
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(
                    None, self.client.login, INSTAGRAM_USERNAME, INSTAGRAM_PASSWORD
                )

                if result:
                    login_via_pw = True
                    logger.info("✅ Login successful via username and password")
            except Exception as e:
                logger.error(f"Couldn't login user using username and password: {e}")

        if not login_via_pw and not login_via_session:
            logger.error("Couldn't login user with either password or session")
            return False

        # Save session for future use
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None, self.client.dump_settings, self.session_file
            )
            logger.info(f"Session saved to {self.session_file}")
        except Exception as e:
            logger.warning(f"Could not save session: {e}")

        return True

    async def _ensure_login(self):
        """Ensure Instagram client is logged in"""
        async with self._login_lock:
            if self._is_logged_in and self.client:
                return True

            success = await self._login_user()
            self._is_logged_in = success
            return success

    async def download_media(self, url: str) -> Optional[str]:
        """
        Download Instagram media (photo, video, reel, or clip)

        Args:
            url: Instagram media URL

        Returns:
            Path to downloaded video file or None if failed or not a video
        """
        try:
            # Ensure we're logged in
            if not await self._ensure_login():
                logger.error("Failed to login to Instagram")
                return None

            # Extract media code from URL
            match = INSTAGRAM_MEDIA_PATTERN.search(url)
            if not match:
                logger.error("Invalid Instagram URL format")
                return None

            media_code = match.group(1)
            logger.info(f"Processing media code: {media_code}")

            loop = asyncio.get_event_loop()

            # Get media PK from code
            media_pk = await loop.run_in_executor(
                None, self.client.media_pk_from_code, media_code
            )

            # Get media info
            media_info = await loop.run_in_executor(
                None, self.client.media_info, media_pk
            )

            # Determine media type and download accordingly
            # media_type: 1 = Photo, 2 = Video/Reel, 8 = Album
            if media_info.media_type == 2:
                # Single video or reel - use clip_download for reels, video_download for regular videos
                if media_info.product_type == "clips":
                    logger.info("Downloading Reels clip...")
                    video_path = await loop.run_in_executor(
                        None,
                        self.client.clip_download,
                        media_pk,
                        str(self.download_dir),
                    )
                else:
                    logger.info("Downloading video...")
                    video_path = await loop.run_in_executor(
                        None,
                        self.client.video_download,
                        media_pk,
                        str(self.download_dir),
                    )
                logger.info(f"✅ Video downloaded: {video_path}")
                return str(video_path)

            elif media_info.media_type == 8:
                # Album/Carousel - download all items and return first video found
                logger.info("Downloading album...")
                album_paths = await loop.run_in_executor(
                    None,
                    self.client.album_download,
                    media_pk,
                    str(self.download_dir),
                )

                # Find first video in album
                for path in album_paths:
                    if str(path).endswith(".mp4"):
                        logger.info(f"✅ Video downloaded from album: {path}")
                        return str(path)

                logger.warning("No video found in album")
                return None

            elif media_info.media_type == 1:
                logger.info("Media is a photo, not a video")
                return None

            else:
                logger.warning(f"Unknown media type: {media_info.media_type}")
                return None

        except LoginRequired as e:
            logger.error(f"Login required: {e}")
            self._is_logged_in = False
            # Try one more time with fresh login
            if await self._ensure_login():
                return await self.download_media(url)
            return None

        except VideoNotDownload as e:
            logger.error(f"Video download failed: {e}")
            return None

        except PleaseWaitFewMinutes as e:
            logger.error(f"Rate limited by Instagram: {e}")
            return None

        except ChallengeRequired as e:
            logger.error(f"Instagram challenge required: {e}")
            return None

        except ClientError as e:
            logger.error(f"Instagram client error: {e}")
            return None

        except Exception as e:
            logger.error(f"Error downloading Instagram media: {e}", exc_info=True)
            return None

    def cleanup_file(self, filepath: str):
        """Delete downloaded file"""
        try:
            if filepath and os.path.exists(filepath):
                os.remove(filepath)
                logger.info(f"Cleaned up file: {filepath}")
        except Exception as e:
            logger.error(f"Error cleaning up file: {e}")

    async def get_status(self) -> dict:
        """Get current login status"""
        status = {
            "logged_in": self._is_logged_in,
            "username": INSTAGRAM_USERNAME,
            "session_file_exists": os.path.exists(self.session_file),
        }
        return status


# Initialize downloader
downloader = InstagramDownloader(DOWNLOAD_DIR, SESSION_FILE)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command"""
    welcome_message = (
        "👋 Hello! I'm the Instagram Media Bot!\n\n"
        "Add me to your group chat and I'll automatically detect Instagram links "
        "(reels, posts, videos) and send them directly to your chat.\n\n"
        "Just share any Instagram link and I'll do the rest! 🎥\n\n"
        "💡 This bot uses persistent sessions - no cookie management needed!"
    )
    await update.message.reply_text(welcome_message)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command"""
    help_message = (
        "ℹ️ How to use:\n\n"
        "1. Add me to your group chat\n"
        "2. Share an Instagram link (reel, post, or video)\n"
        "3. I'll download and send the video!\n\n"
        "Supported formats:\n"
        "• instagram.com/reel/[ID]\n"
        "• instagram.com/reels/[ID]\n"
        "• instagram.com/p/[ID]\n\n"
        "Commands:\n"
        "• /status - Check login status\n"
        "• /login - Force re-login to Instagram\n\n"
        "Note: Make sure I have permission to send videos in the group."
    )
    await update.message.reply_text(help_message)


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /status command to check login status"""
    status = await downloader.get_status()

    status_msg = "📊 Bot Status:\n\n"

    if status["username"]:
        status_msg += f"👤 Instagram Account: {status['username']}\n"
    else:
        status_msg += "❌ No Instagram credentials configured\n"

    if status["logged_in"]:
        status_msg += "✅ Login Status: LOGGED IN\n"
    else:
        status_msg += "⚠️ Login Status: NOT LOGGED IN\n"

    if status["session_file_exists"]:
        status_msg += f"💾 Session File: {SESSION_FILE} ✅\n"
    else:
        status_msg += "💾 Session File: Not found\n"

    status_msg += "\n💡 Sessions are persistent - no cookie management needed!"

    await update.message.reply_text(status_msg)


async def login_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /login command to force re-login"""
    await update.message.reply_text("🔄 Forcing re-login to Instagram...")

    # Reset login state
    downloader._is_logged_in = False
    downloader.client = None

    # Remove old session file
    if os.path.exists(SESSION_FILE):
        try:
            os.remove(SESSION_FILE)
            logger.info("Removed old session file")
        except Exception as e:
            logger.error(f"Error removing session file: {e}")

    # Attempt fresh login
    success = await downloader._ensure_login()

    if success:
        await update.message.reply_text(
            "✅ Successfully logged in to Instagram!\n"
            f"Account: {INSTAGRAM_USERNAME}\n\n"
            "Session has been saved and will persist across restarts."
        )
    else:
        await update.message.reply_text(
            "❌ Login failed!\n\n"
            "Please check:\n"
            "1. INSTAGRAM_USERNAME is correct\n"
            "2. INSTAGRAM_PASSWORD is correct\n"
            "3. Your account isn't locked or requiring verification\n\n"
            "Check the bot logs for more details."
        )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle incoming messages and detect Instagram links"""

    if not update.message or not update.message.text:
        return

    message_text = update.message.text

    # Find all Instagram URLs in the message
    matches = INSTAGRAM_MEDIA_PATTERN.findall(message_text)

    if not matches:
        return

    # Get the full URL matches
    urls = INSTAGRAM_MEDIA_PATTERN.finditer(message_text)

    for url_match in urls:
        instagram_url = url_match.group(0)
        logger.info(f"Detected Instagram URL: {instagram_url}")

        # Send typing action
        await update.message.chat.send_action(ChatAction.UPLOAD_VIDEO)

        # Download the media
        video_path = await downloader.download_media(instagram_url)

        if video_path and os.path.exists(video_path):
            try:
                # Send the video
                with open(video_path, "rb") as video_file:
                    await update.message.reply_video(
                        video=video_file,
                        caption="📹 Instagram Media",
                        supports_streaming=True,
                    )
                logger.info(f"Successfully sent video: {video_path}")
            except Exception as e:
                logger.error(f"Error sending video: {e}")
                await update.message.reply_text(
                    "❌ Sorry, I couldn't send the video. It might be too large or there was an error."
                )
            finally:
                # Clean up downloaded file
                downloader.cleanup_file(video_path)
        else:
            await update.message.reply_text(
                "❌ Sorry, I couldn't download this Instagram media.\n"
                "Possible reasons:\n"
                "• The post is private\n"
                "• The post doesn't contain a video\n"
                "• Instagram rate limiting\n\n"
                "Try /status to check if I'm logged in."
            )


def main():
    """Start the bot"""

    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN not found in environment variables!")
        return

    if not INSTAGRAM_USERNAME or not INSTAGRAM_PASSWORD:
        logger.error(
            "INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set in .env file!"
        )
        return

    # Create application
    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    # Add handlers
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("status", status_command))
    application.add_handler(CommandHandler("login", login_command))
    application.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message)
    )

    # Start the bot
    logger.info("Bot started! Listening for Instagram links...")
    logger.info(f"Instagram account: {INSTAGRAM_USERNAME}")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
