import { openDB, IDBPDatabase } from 'idb';

export interface StoredVideo {
  url: string;
  title: string;
  blob: Blob;
  timestamp: number;
  duration: number;
  thumbnails?: string[];
}

class VideoStorageService {
  private dbName = 'VideoCache';
  private dbVersion = 1;
  private db: IDBPDatabase | null = null;

  async initialize() {
    this.db = await openDB(this.dbName, this.dbVersion, {
      upgrade(db) {
        // Create a store for videos
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos', { keyPath: 'url' });
        }
      },
    });
  }

  async storeVideo(video: StoredVideo): Promise<void> {
    if (!this.db) await this.initialize();
    await this.db!.put('videos', video);
  }

  async getVideo(url: string): Promise<StoredVideo | undefined> {
    if (!this.db) await this.initialize();
    return await this.db!.get('videos', url);
  }

  async getAllVideos(): Promise<StoredVideo[]> {
    if (!this.db) await this.initialize();
    return await this.db!.getAll('videos');
  }

  async deleteVideo(url: string): Promise<void> {
    if (!this.db) await this.initialize();
    await this.db!.delete('videos', url);
  }

  async cleanup(): Promise<void> {
    if (!this.db) await this.initialize();
    
    const videos = await this.getAllVideos();
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;
    
    for (const video of videos) {
      if (now - video.timestamp > dayInMs) {
        await this.deleteVideo(video.url);
      }
    }
  }

  async generateThumbnails(videoBlob: Blob, numThumbnails: number = 20): Promise<string[]> {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const thumbnails: string[] = [];

    return new Promise((resolve, reject) => {
      video.src = URL.createObjectURL(videoBlob);
      
      video.onloadedmetadata = async () => {
        try {
          const duration = video.duration;
          canvas.width = 160;  // thumbnail width
          canvas.height = 90;  // 16:9 aspect ratio

          // Load the video properly
          await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error('Failed to load video data'));
          });

          for (let i = 0; i < numThumbnails; i++) {
            const time = (duration * i) / numThumbnails;
            video.currentTime = time;
            
            await new Promise<void>((resolve, reject) => {
              const timeoutId = setTimeout(() => {
                reject(new Error('Seek timeout'));
              }, 5000); // 5 second timeout

              video.onseeked = () => {
                try {
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                  thumbnails.push(canvas.toDataURL('image/jpeg', 0.7));
                  clearTimeout(timeoutId);
                  resolve();
                } catch (err) {
                  clearTimeout(timeoutId);
                  reject(err);
                }
              };
            });
          }

          URL.revokeObjectURL(video.src);
          resolve(thumbnails);
        } catch (err) {
          URL.revokeObjectURL(video.src);
          reject(err);
        }
      };

      video.onerror = () => {
        URL.revokeObjectURL(video.src);
        reject(new Error('Failed to load video'));
      };

      // Set a timeout for the entire operation
      setTimeout(() => {
        URL.revokeObjectURL(video.src);
        reject(new Error('Thumbnail generation timed out'));
      }, 30000); // 30 second timeout
    });
  }
}

export const videoStorage = new VideoStorageService(); 