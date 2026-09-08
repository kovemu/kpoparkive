from io import BytesIO

import cloudscraper
import requests
from fastapi import FastAPI
from PIL import Image

app = FastAPI()

TEST_URLS = [
    "https://file.namu.moe/file/67e336914029a528fed5dedc601ca2e714d40d0c08220440853cc694d47cc9d199282c6a83abdc17198c9978f9b7f9e0",
    "https://file.namu.moe/file/67e336914029a528fed5dedc601ca2e7c2a90e71b57f461db52a6322757582d7d91116f6625c3f82d7e018d136397cb9",
    "https://file.namu.moe/file/58b7beb9825890faebfd3e2564c10ff3733cfcea1bffbe438af9973e7296abaf25989a6859cf3a0f7411df3d16d6b983",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Referer": "https://www.namu.moe/",
}


def inspect_response(response):
    body = response.content or b""
    content_type = response.headers.get("content-type", "")
    result = {
        "status": response.status_code,
        "final_url": response.url,
        "content_type": content_type,
        "bytes": len(body),
        "cf_ray": response.headers.get("cf-ray"),
        "server": response.headers.get("server"),
        "head_hex": body[:16].hex(),
        "image": False,
        "width": None,
        "height": None,
        "format": None,
    }
    try:
        image = Image.open(BytesIO(body))
        width, height = image.size
        fmt = image.format
        image.verify()
        result.update({
            "image": True,
            "width": width,
            "height": height,
            "format": fmt,
        })
    except Exception as exc:
        result["image_error"] = str(exc)[:200]
    return result


def run_probe():
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False}
    )
    output = []
    for url in TEST_URLS:
        item = {"url": url}
        try:
            plain = requests.get(url, headers=HEADERS, timeout=12, allow_redirects=True)
            item["plain"] = inspect_response(plain)
        except Exception as exc:
            item["plain"] = {"error": str(exc)[:300]}
        try:
            cloud = scraper.get(url, headers=HEADERS, timeout=12, allow_redirects=True)
            item["cloudscraper"] = inspect_response(cloud)
        except Exception as exc:
            item["cloudscraper"] = {"error": str(exc)[:300]}
        output.append(item)
    return {"ok": True, "tests": output}


@app.get("/")
def probe_root():
    return run_probe()


@app.get("/api/namu_cloudscraper_probe")
def probe_file_route():
    return run_probe()
