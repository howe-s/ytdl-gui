from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, validator
import yt_dlp
import io
import logging
import requests
import tempfile
import os
import cv2
import numpy as np
import base64
import time
import subprocess
from pathlib import Path
from imageio_ffmpeg import get_ffmpeg_exe

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Set FFmpeg path for yt-dlp
os.environ["FFMPEG_BINARY"] = get_ffmpeg_exe()
logger.info(f"Using FFmpeg from: {get_ffmpeg_exe()}")

app = FastAPI()

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite's default port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add this after the app initialization
video_cache = {}
CACHE_DURATION = 3600  # 1 hour cache

def cleanup_old_cache():
    current_time = time.time()
    expired = [url for url, data in video_cache.items() 
              if current_time - data['timestamp'] > CACHE_DURATION]
    for url in expired:
        try:
            if Path(video_cache[url]['path']).exists():
                os.unlink(video_cache[url]['path'])
            del video_cache[url]
        except Exception as e:
            logger.error(f"Error cleaning cache for {url}: {e}")

class VideoURL(BaseModel):
    url: str

class VideoDownloadRequest(BaseModel):
    url: str
    format_id: str
    start_time: float  # Start time in seconds
    end_time: float    # End time in seconds

    @validator('end_time')
    def validate_duration(cls, end_time, values):
        start_time = values.get('start_time', 0)
        duration = end_time - start_time
        if duration > 15:
            raise ValueError("Maximum clip duration is 15 seconds")
        if duration <= 0:
            raise ValueError("End time must be greater than start time")
        return end_time

@app.post("/formats")
async def get_formats(video: VideoURL):
    try:
        logger.info(f"Getting available formats for URL: {video.url}")
        
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Get video info
            info = ydl.extract_info(video.url, download=False)
            
            # Get video duration
            duration = info.get('duration', 0)
            
            # Filter and format the available formats
            formats = []
            seen_resolutions = set()
            
            for fmt in info['formats']:
                # Only include video formats (mp4 or webm)
                if fmt.get('vcodec') == 'none':
                    continue
                    
                # Skip formats that are known to be problematic
                if fmt.get('format_note') == 'storyboard':
                    continue

                # Get format details
                height = fmt.get('height', 0)
                width = fmt.get('width', 0)
                ext = fmt.get('ext', 'unknown')
                url = fmt.get('url', '')  # Get the direct URL
                
                # Only process formats with valid height/width
                if height == 0 or width == 0:
                    continue
                
                # Create a resolution key for deduplication
                resolution_key = f"{width}x{height}"
                
                # Skip if we've already seen this resolution
                if resolution_key in seen_resolutions:
                    continue
                
                quality = fmt.get('format_note', 'unknown')
                if height:  # If height is available, use it for quality label
                    if height >= 2160:
                        quality = "4K"
                    elif height >= 1440:
                        quality = "2K"
                    elif height >= 1080:
                        quality = "1080p"
                    elif height >= 720:
                        quality = "720p"
                    elif height >= 480:
                        quality = "480p"
                    elif height >= 360:
                        quality = "360p"
                    else:
                        quality = f"{height}p"
                
                # Create a descriptive quality label
                quality_label = f"{quality} - {width}x{height}"
                
                formats.append({
                    'format_id': fmt['format_id'],
                    'quality': quality_label,
                    'ext': ext,
                    'filesize': fmt.get('filesize', 'unknown'),
                    'resolution': f"{width}x{height}",
                    'has_audio': fmt.get('acodec') != 'none',
                    'url': url  # Include the direct URL
                })
                seen_resolutions.add(resolution_key)
            
            # Sort formats by resolution
            def sort_key(fmt):
                height = int(fmt['resolution'].split('x')[1]) if fmt['resolution'].split('x')[1].isdigit() else 0
                return height
            
            formats.sort(key=sort_key, reverse=True)
            
            return {
                "title": info.get('title', 'Unknown'),
                "duration": duration,
                "formats": formats
            }
            
    except Exception as e:
        logger.error(f"Error getting formats: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/download")
async def download_video(request: VideoDownloadRequest):
    try:
        logger.info(f"Attempting to download video from URL: {request.url}")
        
        # Create a temporary directory that will be automatically cleaned up
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_dir_path = Path(temp_dir)
            temp_full = temp_dir_path / 'full.mp4'
            temp_file = temp_dir_path / 'clip.mp4'
            
            # Configure yt-dlp options
            ydl_opts = {
                'format': f"{request.format_id}+bestaudio[ext=m4a]/bestaudio",
                'merge_output_format': 'mp4',
                'quiet': True,
                'no_warnings': True,
                'outtmpl': str(temp_full),
                'ffmpeg_location': get_ffmpeg_exe(),
                'postprocessors': [{
                    'key': 'FFmpegVideoConvertor',
                    'preferedformat': 'mp4',
                }],
            }
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                try:
                    # Get video info and download
                    logger.info("Extracting video info...")
                    info = ydl.extract_info(request.url, download=True)
                    
                    # Get safe filename
                    filename = info.get('title', 'video').replace('/', '_').replace('\\', '_') + '_clip.mp4'
                    logger.info(f"Downloading video: {filename}")
                    
                    # Check if file exists
                    if not temp_full.exists():
                        raise HTTPException(status_code=500, detail="Failed to download video")
                    
                    # Cut the video to the specified time range using ffmpeg
                    duration = request.end_time - request.start_time
                    ffmpeg_path = Path(get_ffmpeg_exe())
                    
                    try:
                        result = subprocess.run([
                            str(ffmpeg_path),
                            '-i', str(temp_full),
                            '-ss', str(request.start_time),
                            '-t', str(duration),
                            '-c', 'copy',
                            str(temp_file)
                        ], capture_output=True, text=True, check=True)
                        logger.info("FFmpeg trimming completed successfully")
                    except subprocess.CalledProcessError as e:
                        logger.error(f"FFmpeg error: {e.stderr}")
                        raise HTTPException(status_code=500, detail=f"Failed to trim video: {e.stderr}")
                    
                    if not temp_file.exists():
                        raise HTTPException(status_code=500, detail="Failed to trim video - output file not found")
                    
                    # Read the file into memory before returning
                    with open(temp_file, 'rb') as f:
                        video_data = f.read()
                    
                    # Return the video data as a streaming response
                    return StreamingResponse(
                        io.BytesIO(video_data),
                        media_type="video/mp4",
                        headers={
                            "Content-Disposition": f'attachment; filename="{filename}"'
                        }
                    )
                    
                except Exception as e:
                    logger.error(f"Error during video processing: {str(e)}")
                    raise HTTPException(status_code=500, detail=f"Video processing error: {str(e)}")
    
    except HTTPException as he:
        logger.error(f"HTTP Exception: {str(he)}")
        raise he
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")

@app.post("/thumbnails")
async def get_thumbnails(video: VideoURL):
    try:
        logger.info(f"Generating thumbnails for URL: {video.url}")
        temp_dir = tempfile.mkdtemp()
        temp_path = os.path.join(temp_dir, 'video.mp4')
        
        try:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'format': 'best[height<=720][ext=mp4]/best[ext=mp4]/best',  # Use better quality for preview
                'outtmpl': temp_path,
                'no_cache': True,
                'rm_cache_dir': True,
                'force_overwrites': True,
                'ffmpeg_location': get_ffmpeg_exe(),
            }
            
            logger.info("Downloading video for thumbnail generation...")
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # First get video info to verify format selection
                info = ydl.extract_info(video.url, download=False)
                formats = info['formats']
                
                # Find suitable format
                video_formats = [f for f in formats if f.get('ext') in ['mp4', 'webm'] and f.get('vcodec') != 'none']
                if not video_formats:
                    raise HTTPException(status_code=400, detail="No suitable video format found")
                
                # Sort by filesize (ascending) and height >= 360
                suitable_formats = [f for f in video_formats if f.get('height', 0) >= 360]
                if not suitable_formats:
                    suitable_formats = video_formats  # Fallback to any video format
                
                selected_format = min(suitable_formats, key=lambda x: x.get('filesize', float('inf')) if x.get('filesize') else float('inf'))
                logger.info(f"Selected format: {selected_format.get('format_id')} - {selected_format.get('ext')} - {selected_format.get('height')}p")
                
                # Update options with specific format
                ydl_opts['format'] = selected_format['format_id']
                
                # Download the video
                ydl.download([video.url])
            
            if not os.path.exists(temp_path):
                raise HTTPException(status_code=500, detail="Video download failed - file not found")
                
            file_size = os.path.getsize(temp_path)
            if file_size == 0:
                raise HTTPException(status_code=500, detail="Video download failed - empty file")
                
            logger.info(f"Video downloaded successfully. File size: {file_size} bytes")
            
            # Verify the file is a valid video
            logger.info("Opening video file with OpenCV...")
            cap = cv2.VideoCapture(temp_path)
            if not cap.isOpened():
                # Try to copy the file to ensure it's complete
                backup_path = temp_path + '.bak'
                with open(temp_path, 'rb') as src, open(backup_path, 'wb') as dst:
                    dst.write(src.read())
                
                cap = cv2.VideoCapture(backup_path)
                if not cap.isOpened():
                    raise HTTPException(status_code=500, detail="Failed to open video file - invalid format")
                else:
                    temp_path = backup_path

            # Get video properties
            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS)
            
            logger.info(f"Video properties - Frames: {frame_count}, FPS: {fps}")
            
            if frame_count <= 0 or fps <= 0:
                raise HTTPException(status_code=500, detail=f"Invalid video properties: frames={frame_count}, fps={fps}")
                
            duration = frame_count / fps
            if duration <= 0:
                raise HTTPException(status_code=500, detail=f"Invalid video duration: {duration}")

            logger.info(f"Generating {20} thumbnails for {duration} seconds of video...")
            thumbnails = []
            num_thumbnails = 20
            
            for i in range(num_thumbnails):
                position = (duration * i) / num_thumbnails
                logger.info(f"Extracting frame at position {position:.2f}s ({i+1}/{num_thumbnails})")
                
                success = cap.set(cv2.CAP_PROP_POS_MSEC, position * 1000)
                if not success:
                    logger.warning(f"Failed to set position to {position} seconds")
                    continue
                    
                ret, frame = cap.read()
                if not ret:
                    logger.warning(f"Failed to read frame at position {position} seconds")
                    continue
                    
                try:
                    height = 90
                    ratio = height / frame.shape[0]
                    width = int(frame.shape[1] * ratio)
                    frame = cv2.resize(frame, (width, height))
                    
                    _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                    jpg_as_text = base64.b64encode(buffer).decode()
                    thumbnails.append(f"data:image/jpeg;base64,{jpg_as_text}")
                    logger.info(f"Successfully processed frame {i+1}/{num_thumbnails}")
                except Exception as e:
                    logger.error(f"Error processing frame {i}: {str(e)}")
                    continue
            
            cap.release()
            
            if not thumbnails:
                raise HTTPException(status_code=500, detail="Failed to generate any thumbnails")
            
            logger.info(f"Successfully generated {len(thumbnails)} thumbnails")
            
            # After successful video processing, store in cache
            cache_path = os.path.join(temp_dir, 'cached_video.mp4')
            os.rename(temp_path, cache_path)  # Move to permanent cache location
            video_cache[video.url] = {
                'path': cache_path,
                'timestamp': time.time()
            }
            temp_dir = None  # Prevent cleanup of the cache directory
            
            return {"thumbnails": thumbnails, "duration": duration}
            
        finally:
            # Only clean up if we're not caching
            if temp_dir and os.path.exists(temp_dir):
                try:
                    if os.path.exists(temp_path):
                        os.unlink(temp_path)
                    if os.path.exists(temp_path + '.bak'):
                        os.unlink(temp_path + '.bak')
                    os.rmdir(temp_dir)
                except Exception as e:
                    logger.error(f"Error cleaning up temporary files: {str(e)}")
                
    except HTTPException as he:
        logger.error(f"HTTP Exception in thumbnails: {str(he)}")
        raise he
    except Exception as e:
        logger.error(f"Error generating thumbnails: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/preview")
async def preview_video(video: VideoURL):
    try:
        logger.info(f"Getting preview stream for URL: {video.url}")
        
        # Clean up old cache entries
        cleanup_old_cache()
        
        # Check if video is in cache
        if video.url in video_cache and os.path.exists(video_cache[video.url]['path']):
            logger.info("Using cached video file")
            video_path = video_cache[video.url]['path']
        else:
            logger.info("Video not in cache, please fetch thumbnails first")
            raise HTTPException(status_code=400, detail="Please load video information first")
        
        # Stream the cached file
        def iterfile():
            with open(video_path, mode="rb") as file_like:
                yield from file_like
        
        return StreamingResponse(
            iterfile(),
            media_type="video/mp4",
            headers={
                "Accept-Ranges": "bytes",
                "Content-Disposition": "inline"
            }
        )
                
    except Exception as e:
        logger.error(f"Error generating preview: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000) 