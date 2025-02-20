![image](https://github.com/user-attachments/assets/aa031834-7592-4dc3-821b-388e4dda8af3)

# YouTube Video Downloader and Clip Generator

A modern web application that allows users to download YouTube videos in various qualities and create custom clips from them. Built with FastAPI and React.

## Features

- 🎥 Download YouTube videos in multiple quality options
- ✂️ Create custom clips from downloaded videos
- 🎯 Support for various video formats and resolutions
- ⚡ Fast streaming response for downloads
- 🎨 Modern and responsive user interface

## Tech Stack

### Backend
- FastAPI - Modern Python web framework
- yt-dlp - YouTube video download library
- FFmpeg - Video processing
- Pydantic - Data validation
- uvicorn - ASGI server

### Frontend
- React - UI framework
- Vite - Build tool
- Modern UI components

## Getting Started

### Prerequisites
- Python 3.10 or higher
- Node.js 16 or higher
- FFmpeg installed on your system

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd youtubeVideo
```

2. Set up the backend:
```bash
python -m venv .venv
.venv\Scripts\activate  # On Windows
pip install -r requirements.txt
```

3. Set up the frontend:
```bash
cd frontend
npm install
```

### Running the Application

1. Start the backend server:
```bash
# From the root directory
.venv\Scripts\activate  # On Windows
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

2. Start the frontend development server:
```bash
# From the frontend directory
npm run dev
```

The application will be available at:
- Frontend: http://localhost:5173
- Backend API: http://localhost:8000
- API Documentation: http://localhost:8000/docs

## API Endpoints

- `POST /formats` - Get available formats for a YouTube video
- `POST /download` - Download a YouTube video in specified format
- `POST /process-clip` - Create a custom clip from a video


