import { useState, useRef, useEffect } from 'react'
import { videoStorage, StoredVideo } from './services/VideoStorage'

interface VideoFormat {
  format_id: string;
  quality: string;
  ext: string;
  filesize: number | string;
  resolution: string;
  has_audio: boolean;
  url: string;
}

interface VideoInfo {
  title: string;
  duration: number;
  formats: VideoFormat[];
}

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null)
  const [selectedFormat, setSelectedFormat] = useState<string>('')
  const [startTime, setStartTime] = useState(0)
  const [endTime, setEndTime] = useState(10)
  const [acceptedDisclaimer, setAcceptedDisclaimer] = useState(false)
  const [storedVideos, setStoredVideos] = useState<StoredVideo[]>([])
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState<'start' | 'end' | null>(null)
  const [thumbnails, setThumbnails] = useState<string[]>([])

  // Load stored videos on mount
  useEffect(() => {
    const loadStoredVideos = async () => {
      const videos = await videoStorage.getAllVideos();
      setStoredVideos(videos);
    };
    loadStoredVideos();
    
    // Run cleanup periodically
    const cleanup = () => videoStorage.cleanup();
    const interval = setInterval(cleanup, 60 * 60 * 1000); // Every hour
    return () => clearInterval(interval);
  }, []);

  const handleGetFormats = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setVideoInfo(null)
    setPreviewUrl('')
    setThumbnails([])
    setSelectedFormat('')  // Reset selected format

    try {
      // Check if video is already stored
      const existingVideo = await videoStorage.getVideo(url);
      if (existingVideo) {
        setThumbnails(existingVideo.thumbnails || []);
        setVideoInfo({
          title: existingVideo.title,
          duration: existingVideo.duration,
          formats: [] // We don't store formats for cached videos
        });
        const previewObjectUrl = URL.createObjectURL(existingVideo.blob);
        setPreviewUrl(previewObjectUrl);
        setLoading(false);
        return;
      }

      // Get formats from API
      const formatsResponse = await fetch('http://localhost:8000/formats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });

      if (!formatsResponse.ok) {
        throw new Error('Failed to get video formats');
      }

      const data = await formatsResponse.json();
      console.log('Received formats:', data.formats);
      
      // Find the first format that has audio for preview
      const previewFormat = data.formats.find((format: VideoFormat) => format.has_audio);
      
      if (!previewFormat) {
        throw new Error('No suitable preview format found');
      }
      
      // Set video info with all available formats for download
      setVideoInfo({
        ...data,
        formats: data.formats
      });
      
      // Set the first format as default selected format
      if (data.formats.length > 0) {
        setSelectedFormat(data.formats[0].format_id);
      }
      
      // Download the preview format immediately
      const downloadRequest = {
        url: url,
        format_id: previewFormat.format_id
      };
      
      const response = await fetch('http://localhost:8000/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(downloadRequest),
      });

      if (!response.ok) {
        throw new Error('Failed to get video preview');
      }

      // Get video blob from response
      const videoBlob = await response.blob();
      
      // Generate thumbnails
      const newThumbnails = await videoStorage.generateThumbnails(videoBlob);
      setThumbnails(newThumbnails);

      // Create preview URL from blob
      const previewObjectUrl = URL.createObjectURL(videoBlob);
      setPreviewUrl(previewObjectUrl);

      // Store video
      const newStoredVideo: StoredVideo = {
        url,
        title: data.title,
        blob: videoBlob,
        timestamp: Date.now(),
        duration: data.duration,
        thumbnails: newThumbnails
      };

      await videoStorage.storeVideo(newStoredVideo);
      setStoredVideos(await videoStorage.getAllVideos());

    } catch (err) {
      console.error('Error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const currentTime = videoRef.current.currentTime
      if (currentTime < startTime) {
        videoRef.current.currentTime = startTime
      } else if (currentTime > endTime) {
        videoRef.current.currentTime = startTime
        videoRef.current.play()
      }
    }
  }

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoRef.current || !videoInfo) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = x / rect.width
    const time = percentage * videoInfo.duration

    if (time >= 0 && time <= videoInfo.duration) {
      // Update the time range based on click position
      if (Math.abs(time - startTime) < Math.abs(time - endTime)) {
        setStartTime(Math.max(0, Math.min(time, endTime - 1)))
      } else {
        setEndTime(Math.min(videoInfo.duration, Math.max(time, startTime + 1)))
      }
      videoRef.current.currentTime = time
    }
  }

  const handleDownload = async () => {
    if (!selectedFormat || !acceptedDisclaimer || !videoInfo) return;
    
    setLoading(true);
    setError('');

    try {
      // Get stored video
      const existingVideo = await videoStorage.getVideo(url);
      if (!existingVideo) {
        throw new Error('Video not found in storage');
      }

      // Generate clip from stored video
      await handleCreateClip(existingVideo);
    } catch (err) {
      console.error('Download error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateClip = async (video: StoredVideo) => {
    try {
      // Create form data
      const formData = new FormData();
      formData.append('video', video.blob);
      formData.append('start_time', startTime.toString());
      formData.append('end_time', endTime.toString());

      // Process clip
      const clipResponse = await fetch('http://localhost:8000/process-clip', {
        method: 'POST',
        body: formData,
      });

      if (!clipResponse.ok) {
        throw new Error('Failed to process clip');
      }

      // Download the processed clip
      const clipBlob = await clipResponse.blob();
      const clipUrl = URL.createObjectURL(clipBlob);
      
      // Trigger download
      const a = document.createElement('a');
      a.href = clipUrl;
      a.download = `${video.title}_clip.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(clipUrl);

    } catch (err) {
      throw new Error('Failed to create clip: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDeleteVideo = async (videoUrl: string) => {
    try {
      await videoStorage.deleteVideo(videoUrl);
      setStoredVideos(await videoStorage.getAllVideos());
      if (url === videoUrl) {
        setThumbnails([]);
        setVideoInfo(null);
      }
    } catch (err) {
      setError('Failed to delete video');
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>, type: 'start' | 'end') => {
    setIsDragging(type)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !timelineRef.current || !videoInfo) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
    const percentage = x / rect.width
    const time = percentage * videoInfo.duration

    if (isDragging === 'start') {
      const newStart = Math.max(0, Math.min(time, endTime - 1))
      setStartTime(newStart)
      if (videoRef.current) videoRef.current.currentTime = newStart
    } else {
      const newEnd = Math.min(videoInfo.duration, Math.max(time, startTime + 1))
      setEndTime(newEnd)
      if (videoRef.current) videoRef.current.currentTime = newEnd
    }
  }

  const handleMouseUp = () => {
    setIsDragging(null)
  }

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [])

  // Add cleanup for object URLs
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  // Add this new function near the other handlers
  const handleUseStoredVideo = async (videoUrl: string) => {
    setUrl(videoUrl);
    setLoading(true);
    setError('');
    setVideoInfo(null);
    setPreviewUrl('');
    setThumbnails([]);
    setSelectedFormat('');

    try {
      const existingVideo = await videoStorage.getVideo(videoUrl);
      if (existingVideo) {
        setThumbnails(existingVideo.thumbnails || []);
        setVideoInfo({
          title: existingVideo.title,
          duration: existingVideo.duration,
          formats: [] // We don't store formats for cached videos
        });
        const previewObjectUrl = URL.createObjectURL(existingVideo.blob);
        setPreviewUrl(previewObjectUrl);
      } else {
        // If not in storage, fetch formats
        const formatsResponse = await fetch('http://localhost:8000/formats', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: videoUrl }),
        });

        if (!formatsResponse.ok) {
          throw new Error('Failed to get video formats');
        }

        const data = await formatsResponse.json();
        console.log('Received formats:', data.formats);
        
        // Filter formats to only include those with audio
        const formatsWithAudio = data.formats.filter((format: VideoFormat) => format.has_audio);
        console.log('Formats with audio:', formatsWithAudio);
        
        setVideoInfo({
          ...data,
          formats: formatsWithAudio
        });
        
        // Set the first format with audio as default
        if (formatsWithAudio.length > 0) {
          setSelectedFormat(formatsWithAudio[0].format_id);
        }
      }
    } catch (err) {
      console.error('Error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen flex bg-gradient-to-b from-gray-900 to-gray-800">
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3">
        {/* Left Column - Controls */}
        <div className="bg-gray-50 border-r border-gray-200 overflow-y-auto">
          <div className="p-6">
            <h1 className="text-3xl font-bold text-center mb-6 text-gray-800">
              YouTube Clip Creator
            </h1>
            
            {/* Disclaimer */}
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800 mb-6">
              <h2 className="font-bold mb-2">Fair Use Disclaimer</h2>
              <p className="mb-2">This tool is intended for creating clips for:</p>
              <ul className="list-disc pl-5 mb-2">
                <li>Commentary</li>
                <li>Criticism</li>
                <li>News reporting</li>
                <li>Teaching</li>
                <li>Research</li>
              </ul>
              <p className="mb-4">Only download content you have the right to use under fair use guidelines.</p>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="disclaimer"
                  checked={acceptedDisclaimer}
                  onChange={(e) => setAcceptedDisclaimer(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                />
                <label htmlFor="disclaimer" className="ml-2 text-sm text-gray-700">
                  I understand and agree to use this tool responsibly
                </label>
              </div>
            </div>

            {/* Stored Videos */}
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-gray-800 mb-4">Stored Videos</h2>
              <div className="space-y-4">
                {storedVideos.map(video => (
                  <div key={video.url} className="bg-white p-4 rounded-lg shadow">
                    <h3 className="font-medium text-gray-900">{video.title}</h3>
                    <p className="text-sm text-gray-500">
                      {new Date(video.timestamp).toLocaleDateString()}
                    </p>
                    <div className="mt-2 flex space-x-2">
                      <button
                        onClick={() => handleUseStoredVideo(video.url)}
                        className="text-blue-600 hover:text-blue-800 text-sm"
                      >
                        Use
                      </button>
                      <button
                        onClick={() => handleDeleteVideo(video.url)}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <form onSubmit={handleGetFormats} className="space-y-4 mb-6">
      <div>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Enter YouTube URL"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className={`w-full py-2 px-4 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors ${
                  loading ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {loading ? 'Loading...' : 'Get Video'}
              </button>
            </form>

            {videoInfo && (
              <div className="space-y-6">
                <h2 className="text-xl font-semibold text-gray-800 border-b pb-2">
                  {videoInfo.title}
                </h2>

                {/* Clip Duration Display */}
                <div className="bg-gray-100 p-4 rounded-lg">
                  <div className="text-sm font-medium text-gray-700 mb-2">
                    Selected Clip:
                  </div>
                  <div className="flex justify-between items-center text-gray-600">
                    <div>{formatTime(startTime)}</div>
                    <div className="text-gray-400">to</div>
                    <div>{formatTime(endTime)}</div>
                  </div>
                  <div className="text-sm text-gray-500 mt-2 text-center">
                    Duration: {(endTime - startTime).toFixed(1)} seconds
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Download Format:
                  </label>
                  <select
                    value={selectedFormat}
                    onChange={(e) => setSelectedFormat(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Select a format</option>
                    {videoInfo.formats.map((format) => (
                      <option 
                        key={format.format_id} 
                        value={format.format_id}
                      >
                        {format.quality}
                      </option>
                    ))}
                  </select>
      </div>

                <button
                  onClick={handleDownload}
                  disabled={loading || !selectedFormat || !acceptedDisclaimer}
                  className={`w-full py-2 px-4 rounded-lg font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors ${
                    loading || !selectedFormat || !acceptedDisclaimer ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  {loading ? 'Downloading...' : 'Download Clip'}
        </button>
              </div>
            )}

            {error && (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-center">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Right Column - Video Preview */}
        <div className="col-span-2 bg-black flex flex-col h-screen">
          <div className="flex flex-col h-full">
            {/* Video Container */}
            <div className="flex-1 relative">
              {previewUrl ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black">
                  <video
                    ref={videoRef}
                    src={previewUrl}
                    className="w-full h-full object-contain"
                    onTimeUpdate={handleTimeUpdate}
                    controls
                    controlsList="nodownload"
                    playsInline
                    onLoadedData={() => {
                      if (videoRef.current) {
                        videoRef.current.currentTime = startTime;
                      }
                    }}
                    onError={(e) => {
                      console.error('Video error:', e);
                      setError('Failed to load video preview');
                      setPreviewUrl('');
                    }}
                  />
                </div>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  {loading ? (
                    <div className="text-lg text-white font-medium px-6 py-3 rounded-lg bg-black/70 backdrop-blur-sm">
                      Loading video...
                    </div>
                  ) : videoInfo && thumbnails.length > 0 ? (
                    <div 
                      className="w-full h-full bg-no-repeat bg-center bg-contain relative cursor-pointer group"
                      style={{
                        backgroundImage: `url(${thumbnails[Math.floor(thumbnails.length / 2)]})`,
                      }}
                      onClick={async () => {
                        try {
                          setLoading(true);
                          setError('');
                          
                          // Get video from storage
                          const storedVideo = await videoStorage.getVideo(url);
                          if (!storedVideo) {
                            throw new Error('Video not found in storage');
                          }
                          
                          // Create preview URL from stored blob
                          const videoUrl = URL.createObjectURL(storedVideo.blob);
                          setPreviewUrl(videoUrl);
                        } catch (err) {
                          console.error('Preview error:', err);
                          setError(err instanceof Error ? err.message : 'Failed to load video preview');
                        } finally {
                          setLoading(false);
                        }
                      }}
                    >
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                        <div className="w-20 h-20 rounded-full bg-black/50 flex items-center justify-center group-hover:scale-110 transition-transform">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-lg text-gray-400">
                      Enter a YouTube URL to preview video
                    </p>
                  )}
                </div>
              )}
            </div>
            
            {/* Timeline */}
            {videoInfo && (
              <div className="bg-gray-900 p-4">
                <div 
                  ref={timelineRef}
                  className="relative h-24 bg-gray-800 rounded-lg cursor-pointer overflow-hidden shadow-inner border border-gray-700"
                  onClick={handleTimelineClick}
                  onMouseMove={handleMouseMove}
                >
                  {/* Frame Previews */}
                  <div className="absolute inset-0 flex">
                    {thumbnails.length > 0 ? (
                      thumbnails.map((thumbnail, index) => (
                        <div
                          key={index}
                          className="h-full"
                          style={{
                            width: `${100 / thumbnails.length}%`,
                            backgroundImage: `url(${thumbnail})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                            borderRight: index < thumbnails.length - 1 ? '1px solid rgba(0,0,0,0.3)' : 'none'
                          }}
                        />
                      ))
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-500">
                        Loading thumbnails...
                      </div>
                    )}
                  </div>

                  {/* Selection Range */}
                  <div 
                    className="absolute h-full bg-blue-500/30 backdrop-blur-sm border-x-2 border-blue-500 group"
                    style={{
                      left: `${(startTime / videoInfo.duration) * 100}%`,
                      width: `${((endTime - startTime) / videoInfo.duration) * 100}%`,
                      zIndex: 20
                    }}
                  >
                    {/* Left Handle */}
                    <div
                      className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-600/50 group-hover:bg-blue-500/50"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        handleMouseDown(e, 'start')
                      }}
                    />
                    {/* Right Handle */}
                    <div
                      className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-600/50 group-hover:bg-blue-500/50"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        handleMouseDown(e, 'end')
                      }}
                    />
                  </div>
                  
                  {/* Current Time Indicator */}
                  {videoRef.current && (
                    <div 
                      className="absolute w-1 h-full bg-blue-500 shadow-lg"
                      style={{
                        left: `${(videoRef.current.currentTime / videoInfo.duration) * 100}%`,
                        zIndex: 30
                      }}
                    />
                  )}

                  {/* Time Labels */}
                  <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-1 bg-black/50 text-xs text-white">
                    <span>{formatTime(startTime)}</span>
                    <span>{formatTime(endTime)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
