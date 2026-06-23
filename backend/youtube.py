import re
from urllib.parse import urlparse, parse_qs


def extract_video_id(url):
    qs = parse_qs(urlparse(url).query)
    if "v" in qs and qs["v"]:
        return qs["v"][0]
    m = re.search(r"youtu\.be/([\w-]{11})", url)
    if m:
        return m.group(1)
    m = re.search(r"[?&]v=([\w-]{11})", url)
    return m.group(1) if m else None


def get_metadata(url):
    import yt_dlp

    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        "videoId": info.get("id"),
        "title": info.get("title"),
        "artist": info.get("artist"),
        "track": info.get("track"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader") or info.get("channel"),
    }
