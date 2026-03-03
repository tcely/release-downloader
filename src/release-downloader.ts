import * as core from '@actions/core'
import * as fs from 'fs'
import * as io from '@actions/io'
import * as path from 'path'
import * as thc from 'typed-rest-client/HttpClient'
import * as crypto from 'crypto'
import { minimatch } from 'minimatch'

import { DownloadMetaData, GithubRelease } from './gh-api'
import { IHeaders, IHttpClientResponse } from 'typed-rest-client/Interfaces'

import { IReleaseDownloadSettings } from './download-settings'

export class ReleaseDownloader {
  private httpClient: thc.HttpClient

  private apiRoot: string
  private supportedHashes: string[]

  constructor(httpClient: thc.HttpClient, githubApiUrl: string) {
    this.httpClient = httpClient
    this.apiRoot = githubApiUrl
    this.supportedHashes = crypto.getHashes()
  }

  /**
   * Translates GitHub "algo:hash" to Node.js crypto names.
   */
  private parseDigest(digest: string): { algorithm: string; expectedHash: string } | undefined {
    if (!digest || !digest.includes(':')) return undefined
    const [ghAlgo, hash] = digest.split(':')
    const normalizedAlgo = ghAlgo.toLowerCase().replace('-', '')
    
    if (!this.supportedHashes.includes(normalizedAlgo)) {
      core.warning(`Unsupported digest algorithm '${ghAlgo}'. Skipping verification.`)
      return undefined
    }
    return { algorithm: normalizedAlgo, expectedHash: hash.toLowerCase() }
  }

  async download(
    downloadSettings: IReleaseDownloadSettings
  ): Promise<string[]> {
    let ghRelease: GithubRelease

    if (downloadSettings.isLatest) {
      ghRelease = await this.getlatestRelease(
        downloadSettings.sourceRepoPath,
        downloadSettings.preRelease
      )
    } else if (downloadSettings.tag !== '') {
      ghRelease = await this.getReleaseByTag(
        downloadSettings.sourceRepoPath,
        downloadSettings.tag
      )
    } else if (downloadSettings.id !== '') {
      ghRelease = await this.getReleaseById(
        downloadSettings.sourceRepoPath,
        downloadSettings.id
      )
    } else {
      throw new Error(
        'Config error: Please input a valid tag or release ID, or specify `latest`'
      )
    }

    const resolvedAssets: DownloadMetaData[] = this.resolveAssets(
      ghRelease,
      downloadSettings
    )

    const result = await this.downloadReleaseAssets(
      resolvedAssets,
      downloadSettings.outFilePath
    )

    // Set the output variables for use by other actions
    core.setOutput('tag_name', ghRelease.tag_name)
    core.setOutput('release_name', ghRelease.name)
    core.setOutput('downloaded_files', result)

    return result
  }

  /**
   * Gets the latest release metadata from github api
   * @param repoPath The source repository path. {owner}/{repo}
   */
  private async getlatestRelease(
    repoPath: string,
    preRelease: boolean
  ): Promise<GithubRelease> {
    core.info(`Fetching latest release for repo ${repoPath}`)

    const headers: IHeaders = { Accept: 'application/vnd.github.v3+json' }
    let response: IHttpClientResponse

    if (!preRelease) {
      response = await this.httpClient.get(
        `${this.apiRoot}/repos/${repoPath}/releases/latest`,
        headers
      )
    } else {
      response = await this.httpClient.get(
        `${this.apiRoot}/repos/${repoPath}/releases`,
        headers
      )
    }

    if (response.message.statusCode !== 200) {
      const err: Error = new Error(
        `[getlatestRelease] Unexpected response: ${response.message.statusCode}`
      )
      throw err
    }

    const responseBody = await response.readBody()

    let release: GithubRelease
    if (!preRelease) {
      release = JSON.parse(responseBody.toString())
      core.info(`Found latest release version: ${release.tag_name}`)
    } else {
      const allReleases: GithubRelease[] = JSON.parse(responseBody.toString())
      const latestPreRelease: GithubRelease | undefined = allReleases.find(
        r => r.prerelease === true
      )

      if (latestPreRelease) {
        release = latestPreRelease
        core.info(`Found latest pre-release version: ${release.tag_name}`)
      } else {
        throw new Error('No prereleases found!')
      }
    }

    return release
  }

  /**
   * Gets release data of the specified tag
   * @param repoPath The source repository
   * @param tag The github tag to fetch release from.
   */
  private async getReleaseByTag(
    repoPath: string,
    tag: string
  ): Promise<GithubRelease> {
    core.info(`Fetching release ${tag} from repo ${repoPath}`)

    if (tag === '') {
      throw new Error('Config error: Please input a valid tag')
    }

    const headers: IHeaders = { Accept: 'application/vnd.github.v3+json' }

    const response = await this.httpClient.get(
      `${this.apiRoot}/repos/${repoPath}/releases/tags/${tag}`,
      headers
    )

    if (response.message.statusCode !== 200) {
      const err: Error = new Error(
        `[getReleaseByTag] Unexpected response: ${response.message.statusCode}`
      )
      throw err
    }

    const responseBody = await response.readBody()
    const release: GithubRelease = JSON.parse(responseBody.toString())
    core.info(`Found release tag: ${release.tag_name}`)

    return release
  }

  /**
   * Gets release data of the specified release ID
   * @param repoPath The source repository
   * @param id The github release ID to fetch.
   */
  private async getReleaseById(
    repoPath: string,
    id: string
  ): Promise<GithubRelease> {
    core.info(`Fetching release id:${id} from repo ${repoPath}`)

    if (id === '') {
      throw new Error('Config error: Please input a valid release ID')
    }

    const headers: IHeaders = { Accept: 'application/vnd.github.v3+json' }

    const response = await this.httpClient.get(
      `${this.apiRoot}/repos/${repoPath}/releases/${id}`,
      headers
    )

    if (response.message.statusCode !== 200) {
      const err: Error = new Error(
        `[getReleaseById] Unexpected response: ${response.message.statusCode}`
      )
      throw err
    }

    const responseBody = await response.readBody()
    const release: GithubRelease = JSON.parse(responseBody.toString())
    core.info(`Found release tag: ${release.tag_name}`)

    return release
  }

  private resolveAssets(
    ghRelease: GithubRelease,
    downloadSettings: IReleaseDownloadSettings
  ): DownloadMetaData[] {
    const downloads: DownloadMetaData[] = []
    const DIGEST_ROLLOUT_DATE = new Date('2025-07-01T00:00:00Z')

    if (downloadSettings.fileName.length > 0) {
      if (ghRelease && ghRelease.assets.length > 0) {
        for (const asset of ghRelease.assets) {
          // download only matching file names
          if (!minimatch(asset.name, downloadSettings.fileName)) {
            continue
          }

          const verification = asset.digest ? this.parseDigest(asset.digest) : undefined
          const assetUpdateDate = new Date(asset.updated_at)

          // 2025 Rollout Logic: Warn if post-July 1st asset lacks digest
          if (assetUpdateDate >= DIGEST_ROLLOUT_DATE && !verification) {
            core.warning(`Asset '${asset.name}' updated after 2025-07-01 but missing digest.`)
          }

          const dData: DownloadMetaData = {
            fileName: asset.name,
            url: asset.url,
            isTarBallOrZipBall: false,
            verification
          }
          downloads.push(dData)
        }

        if (downloads.length === 0) {
          throw new Error(
            `Asset with name ${downloadSettings.fileName} not found!`
          )
        }
      } else {
        throw new Error(`No assets found in release ${ghRelease.name}`)
      }
    }

    const repoName = downloadSettings.sourceRepoPath.split('/').pop()
    if (downloadSettings.tarBall) {
      downloads.push({
        fileName: `${repoName}-${ghRelease.tag_name}.tar.gz`,
        url: ghRelease.tarball_url,
        isTarBallOrZipBall: true
      })
    }

    if (downloadSettings.zipBall) {
      downloads.push({
        fileName: `${repoName}-${ghRelease.tag_name}.zip`,
        url: ghRelease.zipball_url,
        isTarBallOrZipBall: true
      })
    }

    return downloads
  }

  /**
   * Downloads the specified assets from a given URL
   * @param dData The download metadata
   * @param out Target directory
   */
  private async downloadReleaseAssets(
    dData: DownloadMetaData[],
    out: string
  ): Promise<string[]> {
    const outFileDir = path.resolve(out)

    if (!fs.existsSync(outFileDir)) {
      await io.mkdirP(outFileDir)
    }

    // Hidden temp directory in destination directory for atomic cleanup
    const tempDir = path.join(outFileDir, `.temp_${crypto.randomBytes(4).toString('hex')}`)
    await io.mkdirP(tempDir)

    try {
      const downloadedTempPaths: string[] = []
      
      for (const asset of dData) {
        const tempFilePath = path.join(tempDir, asset.fileName)
        await this.downloadFile(asset, tempFilePath)
        downloadedTempPaths.push(tempFilePath)
      }

      const finalPaths: string[] = []

      for (const tempPath of downloadedTempPaths) {
        const finalPath = path.join(outFileDir, path.basename(tempPath))
        
        if (fs.existsSync(finalPath)) {
          const stats = fs.lstatSync(finalPath)
          if (stats.isFile() || stats.isSymbolicLink()) {
            await fs.promises.unlink(finalPath)
          } else if (stats.isDirectory()) {
            throw new Error(`Conflict: '${finalPath}' is a directory and cannot be overwritten.`)
          }
        }
        
        await fs.promises.rename(tempPath, finalPath)
        finalPaths.push(finalPath)
      }

      // Cleanup ensures directory is strictly empty (sanity check)
      try {
        await fs.promises.rmdir(tempDir) 
      } catch (err: unknown) {
        let msg = `Cleanup Error: `
        if (err instanceof Error && 'code' in err && (err as {code: string}).code === 'ENOTEMPTY') {
          msg += `Temp directory '${tempDir}' was not empty.`
        } else {
          msg += err instanceof Error ? err.message : String(err)
        }
        throw new Error(msg)
      }

      return finalPaths

    } catch (error: unknown) {
      core.error(`Download/Verification failed. Purging temporary directory: ${tempDir}`)
      await fs.promises.rm(tempDir, { recursive: true, force: true })
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * Downloads an individual file and verifies its digest if available
   * @param asset Asset metadata
   * @param tempPath Path to save the temporary file
   */
  private async downloadFile(
    asset: DownloadMetaData,
    tempPath: string
  ): Promise<void> {
    const headers: IHeaders = { 
      Accept: asset.isTarBallOrZipBall ? '*/*' : 'application/octet-stream'
    }

    core.info(`Downloading file: ${asset.fileName} to: ${tempPath}`)
    const response = await this.httpClient.get(asset.url, headers)

    if (response.message.statusCode !== 200) {
      const err: Error = new Error(
        `Asset download failed: HTTP ${response.message.statusCode}`
      )
      throw err
    }

    const fileStream = fs.createWriteStream(tempPath)
    await new Promise<void>((resolve, reject) => {
      fileStream.on('error', reject)
      response.message.pipe(fileStream).on('close', resolve)
    })

    // Verification Logic: only run if GitHub provided a digest (2025 feature)
    if (asset.verification) {
      const { algorithm, expectedHash } = asset.verification
      const actualHash = await this.calculateHash(tempPath, algorithm)
      if (actualHash !== expectedHash) {
        throw new Error(`Integrity check failed for ${asset.fileName}. Expected (${algorithm}): ${expectedHash}, Actual: ${actualHash}`)
      }
      core.info(`Verified integrity for ${asset.fileName}`)
    }
  }

  /**
   * Calculates the hash of a file
   * @param filePath Path to the file
   * @param algorithm Crypto algorithm to use
   */
  private async calculateHash(filePath: string, algorithm: string): Promise<string> {
    const hash = crypto.createHash(algorithm)
    const stream = fs.createReadStream(filePath)
    return new Promise((resolve, reject) => {
      stream.on('data', data => hash.update(data))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }
}
