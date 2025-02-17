import { useState, useRef, useEffect } from 'react'

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
  const [startTime, setStartTime] = useState(17)
  const [endTime, setEndTime] = useState(27)
  const [acceptedDisclaimer, setAcceptedDisclaimer] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState<'start' | 'end' | null>(null)
  const [thumbnails, setThumbnails] = useState<string[]>([])

  const handleGetFormats = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setVideoInfo(null)
    setPreviewUrl('')
    setThumbnails([])

    try {
      console.log('Fetching formats...')
      const formatsResponse = await fetch('http://localhost:8000/formats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      })

      if (!formatsResponse.ok) {
        throw new Error('Failed to get video formats')
      }

      const data = await formatsResponse.json()
      console.log('Got formats:', data)
      setVideoInfo(data)
      
      const formats = data.formats.filter((f: VideoFormat) => f.has_audio)
      if (formats.length > 0) {
        setSelectedFormat(formats[0].format_id)
      }

      console.log('Fetching thumbnails...')
      const thumbnailsResponse = await fetch('http://localhost:8000/thumbnails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      })

      if (thumbnailsResponse.ok) {
        const thumbnailData = await thumbnailsResponse.json()
        console.log('Got thumbnails:', thumbnailData.thumbnails.length)
        setThumbnails(thumbnailData.thumbnails)
      } else {
        console.error('Failed to get thumbnails:', await thumbnailsResponse.text())
      }
      
      setStartTime(17)
      setEndTime(27)
    } catch (err) {
      console.error('Error:', err)
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

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
    if (!selectedFormat || !acceptedDisclaimer) return
    
    setLoading(true)
    setError('')

    try {
      const response = await fetch('http://localhost:8000/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          url, 
          format_id: selectedFormat,
          start_time: startTime,
          end_time: endTime
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to download video')
      }

      const blob = await response.blob()
      const downloadUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = 'video_clip.mp4'
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(downloadUrl)
      document.body.removeChild(a)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

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
              <p className="mb-2">This tool is intended for creating short clips (max 15 seconds) for:</p>
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
                    {videoInfo.formats.map((format) => (
                      <option 
                        key={format.format_id} 
                        value={format.format_id}
                        className={format.has_audio ? 'text-black' : 'text-gray-500'}
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
                    className="absolute w-full h-full object-contain"
                    onTimeUpdate={handleTimeUpdate}
                    controls
                    controlsList="nodownload"
                    playsInline
                    onLoadedData={() => {
                      if (videoRef.current) {
                        videoRef.current.currentTime = startTime
                        videoRef.current.play().catch(err => {
                          console.error('Failed to play video:', err)
                          setError('Failed to play video. Please try again.')
                        })
                      }
                    }}
                    onError={(e) => {
                      console.error('Video error:', e)
                      setError('Failed to load video preview')
                      setPreviewUrl('')
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
                        if (videoInfo) {
                          try {
                            setLoading(true)
                            setError('')
                            
                            // The video should already be cached from thumbnails generation
                            const response = await fetch('http://localhost:8000/preview', {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                              },
                              body: JSON.stringify({ url }),
                            })
                            
                            if (!response.ok) {
                              const errorText = await response.text()
                              throw new Error(errorText)
                            }
                            
                            const blob = await response.blob()
                            const videoUrl = URL.createObjectURL(blob)
                            setPreviewUrl(videoUrl)
                          } catch (err) {
                            console.error('Preview error:', err)
                            setError(err instanceof Error ? err.message : 'Failed to load video preview')
                            setPreviewUrl('')
                          } finally {
                            setLoading(false)
                          }
                        }
                      }}
                    >
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                        {loading ? (
                          <div className="text-lg text-white font-medium px-6 py-3 rounded-lg bg-black/70 backdrop-blur-sm">
                            Loading video...
                          </div>
                        ) : (
                          <div className="w-20 h-20 rounded-full bg-black/50 flex items-center justify-center group-hover:scale-110 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </div>
                        )}
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
