from fastapi import FastAPI, HTTPException, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
import yt_dlp
import logging
import tempfile
import os
import subprocess
import aiohttp
import asyncio
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

class VideoURL(BaseModel):
    url: str

    @field_validator('url')
    @classmethod
    def validate_url(cls, v):
        if not v.startswith(('http://', 'https://')):
            raise ValueError('URL must start with http:// or https://')
        return v

class VideoDownloadRequest(BaseModel):
    url: str
    format_id: str

    @field_validator('url')
    @classmethod
    def validate_url(cls, v):
        if not v.startswith(('http://', 'https://')):
            raise ValueError('URL must start with http:// or https://')
        return v

    @field_validator('format_id')
    @classmethod
    def validate_format_id(cls, v):
        if not v:
            raise ValueError('Format ID is required')
        return v

async def stream_video(url: str):
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            return await response.read()

@app.post("/formats")
async def get_formats(video: VideoURL):
    """Get available formats for a YouTube video without downloading"""
    try:
        logger.info(f"Getting available formats for URL: {video.url}")
        
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Get video info without downloading
            info = ydl.extract_info(video.url, download=False)
            logger.info(f"Successfully extracted video info for {info.get('title', 'Unknown')}")
            
            # Get video duration
            duration = info.get('duration', 0)
            
            # Filter and format the available formats
            formats = []
            seen_qualities = set()
            
            for fmt in info['formats']:
                # Skip formats that are known to be problematic
                if fmt.get('format_note') == 'storyboard':
                    continue

                # Get format details
                height = fmt.get('height', 0)
                width = fmt.get('width', 0)
                ext = fmt.get('ext', 'unknown')
                vcodec = fmt.get('vcodec', 'none')
                acodec = fmt.get('acodec', 'none')
                
                # Skip formats without video or audio
                if vcodec == 'none' or acodec == 'none':
                    continue
                
                # Create a quality key for deduplication
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
                    elif height >= 240:
                        quality = "240p"
                    else:
                        quality = f"{height}p"
                
                # Include codec info in the quality label
                quality_key = f"{quality}_{ext}"
                
                format_info = {
                    'format_id': fmt['format_id'],
                    'quality': f"{quality} ({ext})",
                    'ext': ext,
                    'filesize': fmt.get('filesize', 'unknown'),
                    'resolution': f"{width}x{height}" if width and height else 'unknown',
                    'has_audio': True  # We only include formats with audio now
                }
                
                formats.append(format_info)
                logger.info(f"Added format: {format_info}")
            
            # Sort formats by resolution (if available) and then by filesize
            def sort_key(x):
                # Get height from resolution
                height = 0
                if x['resolution'] != 'unknown':
                    try:
                        height = int(x['resolution'].split('x')[1])
                    except (IndexError, ValueError):
                        pass

                # Get filesize, using -1 for unknown/None values
                filesize = -1
                if x['filesize'] not in ('unknown', None):
                    try:
                        filesize = float(x['filesize'])
                    except (TypeError, ValueError):
                        pass

                return (height, -filesize)  # Negative filesize to sort largest first

            formats.sort(key=sort_key, reverse=True)
            
            response_data = {
                "title": info.get('title', 'Unknown'),
                "duration": duration,
                "formats": formats
            }
            
            logger.info(f"Returning {len(formats)} formats")
            return response_data
            
    except Exception as e:
        logger.error(f"Error getting formats: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/download")
async def download_video(request: VideoDownloadRequest):
    """Download and stream the video"""
    try:
        logger.info(f"Getting download URL for: {request.url} with format: {request.format_id}")
        
        ydl_opts = {
            'format': request.format_id,
            'quiet': True,
            'no_warnings': True,
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            try:
                info = ydl.extract_info(request.url, download=False)
                logger.info(f"Successfully extracted video info")
                
                # Get the direct URL for the selected format
                selected_format = next(
                    (f for f in info['formats'] if f['format_id'] == request.format_id),
                    None
                )
                
                if not selected_format:
                    logger.error(f"Format {request.format_id} not found in available formats")
                    raise HTTPException(status_code=400, detail="Selected format not found")
                
                logger.info(f"Found format, streaming video")
                
                # Download and stream the video
                video_data = await stream_video(selected_format['url'])
                
                return StreamingResponse(
                    iter([video_data]),
                    media_type="video/mp4",
                    headers={
                        "Content-Disposition": f'attachment; filename="{info.get("title", "video")}.mp4"',
                        "Content-Length": str(len(video_data))
                    }
                )
                
            except yt_dlp.utils.DownloadError as e:
                logger.error(f"yt-dlp error: {str(e)}")
                raise HTTPException(status_code=400, detail=str(e))
            
    except Exception as e:
        logger.error(f"Error getting download URL: {str(e)}")
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/process-clip")
async def process_clip(
    video: UploadFile = File(...),
    start_time: float = Form(...),
    end_time: float = Form(...)
):
    """Process a video clip using the provided video data"""
    temp_dir = None
    try:
        logger.info(f"Processing clip from {start_time}s to {end_time}s")
        
        # Create temporary directory
        temp_dir = tempfile.mkdtemp()
        temp_dir_path = Path(temp_dir)
        input_path = temp_dir_path / "input.mp4"
        output_path = temp_dir_path / "clip.mp4"
        
        # Save uploaded video chunk to temp file
        logger.info("Saving uploaded video to temp file")
        with open(input_path, 'wb') as f:
            content = await video.read()
            f.write(content)
        
        logger.info(f"Video saved to temp file, size: {os.path.getsize(input_path)} bytes")
        
        # Process the clip
        duration = end_time - start_time
        ffmpeg_path = Path(get_ffmpeg_exe())
        
        # Construct FFmpeg command
        cmd = [
            str(ffmpeg_path),
            '-y',  # Overwrite output file if it exists
            '-ss', str(start_time),  # Seek before input
            '-i', str(input_path),
            '-t', str(duration),
            '-c:v', 'libx264',  # Use H.264 codec
            '-preset', 'ultrafast',  # Fast encoding
            '-c:a', 'aac',  # Use AAC audio codec
            '-strict', 'experimental',
            str(output_path)
        ]
        
        logger.info(f"Running FFmpeg command: {' '.join(cmd)}")
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True
            )
            logger.info("FFmpeg processing completed successfully")
        except subprocess.CalledProcessError as e:
            logger.error(f"FFmpeg stderr: {e.stderr}")
            logger.error(f"FFmpeg stdout: {e.stdout}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to process clip. FFmpeg error: {e.stderr}"
            )
        
        if not output_path.exists():
            raise HTTPException(
                status_code=500,
                detail="Failed to create clip - output file not found"
            )
        
        output_size = os.path.getsize(output_path)
        logger.info(f"Clip created successfully, size: {output_size} bytes")
        
        if output_size == 0:
            raise HTTPException(
                status_code=500,
                detail="Failed to create clip - output file is empty"
            )
        
        # Read the file into memory before returning
        with open(output_path, 'rb') as f:
            video_data = f.read()
        
        # Return the processed clip
        return StreamingResponse(
            iter([video_data]),
            media_type="video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="clip.mp4"'
            }
        )
            
    except Exception as e:
        logger.error(f"Error processing clip: {str(e)}")
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clean up temporary directory
        if temp_dir and os.path.exists(temp_dir):
            try:
                import shutil
                shutil.rmtree(temp_dir)
                logger.info(f"Cleaned up temporary directory: {temp_dir}")
            except Exception as e:
                logger.error(f"Error cleaning up temporary directory: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000) 