interface GhAsset {
  name: string
  url: string
  updated_at: string
  digest?: string
}

export interface GithubRelease {
  name: string
  id: number
  tag_name: string
  prerelease: boolean
  assets: GhAsset[]
  tarball_url: string
  zipball_url: string
}

export interface DownloadMetaData {
  fileName: string
  url: string
  isTarBallOrZipBall: boolean
  verification?: {
    algorithm: string
    expectedHash: string
  }
}
