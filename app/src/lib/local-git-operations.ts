import { WorkingDirectoryStatus, WorkingDirectoryFileChange, FileChange, FileStatus, DiffSelection } from '../models/status'
import Repository from '../models/repository'

import { GitProcess, GitError, GitErrorCode } from './git-process'

/** The encapsulation of the result from 'git status' */
export class StatusResult {
  /** true if the repository exists at the given location */
  public readonly exists: boolean

  /** the absolute path to the repository's working directory */
  public readonly workingDirectory: WorkingDirectoryStatus

  /** factory method when 'git status' is unsuccessful */
  public static NotFound(): StatusResult {
    return new StatusResult(false, new WorkingDirectoryStatus(new Array<WorkingDirectoryFileChange>(), true))
  }

  /** factory method for a successful 'git status' result  */
  public static FromStatus(status: WorkingDirectoryStatus): StatusResult {
    return new StatusResult(true, status)
  }

  public constructor(exists: boolean, workingDirectory: WorkingDirectoryStatus) {
    this.exists = exists
    this.workingDirectory = workingDirectory
  }
}

/** A git commit. */
export class Commit {
  /** The commit's SHA. */
  public readonly sha: string

  /** The first line of the commit message. */
  public readonly summary: string

  /** The commit message without the first line and CR. */
  public readonly body: string
  public readonly authorName: string
  public readonly authorEmail: string
  public readonly authorDate: Date

  public constructor(sha: string, summary: string, body: string, authorName: string, authorEmail: string, authorDate: Date) {
    this.sha = sha
    this.summary = summary
    this.body = body
    this.authorName = authorName
    this.authorEmail = authorEmail
    this.authorDate = authorDate
  }
}

/** indicate what a line in the diff represents */
export enum DiffLineType {
  Context, Add, Delete, Hunk
}

/** track details related to each line in the diff */
export class DiffLine {
  public readonly text: string
  public readonly type: DiffLineType
  public readonly oldLineNumber: number | null
  public readonly newLineNumber: number | null
  public selected: boolean

  public constructor(text: string, type: DiffLineType, oldLineNumber: number | null, newLineNuber: number | null) {
    this.text = text
    this.type = type
    this.oldLineNumber = oldLineNumber
    this.newLineNumber = newLineNuber
    this.selected = false
  }
}

/** details about the start and end of a section of a diff */
export class DiffSectionRange {
  public readonly oldStartLine: number
  public readonly oldEndLine: number
  public readonly newStartLine: number
  public readonly newEndLine: number

  public constructor(oldStartLine: number, oldEndLine: number, newStartLine: number, newEndLine: number) {
    this.oldStartLine = oldStartLine
    this.oldEndLine = oldEndLine
    this.newStartLine = newStartLine
    this.newEndLine = newEndLine
  }
}

/** each diff is made up of a number of sections */
export class DiffSection {
  public readonly range: DiffSectionRange
  public readonly lines: ReadonlyArray<DiffLine>
  public readonly startDiffSection: number
  public readonly endDiffSection: number

  /** infer the type of a diff line based on the prefix */
  private static mapToDiffLineType(text: string) {
    if (text.startsWith('-')) {
        return DiffLineType.Delete
    } else if (text.startsWith('+')) {
        return DiffLineType.Add
    } else {
        return DiffLineType.Context
    }
  }

  public constructor(range: DiffSectionRange, lines: string[], startDiffSection: number, endDiffSection: number) {
    this.range = range
    this.startDiffSection = startDiffSection
    this.endDiffSection = endDiffSection

    let rollingDiffBeforeCounter = range.oldStartLine
    let rollingDiffAfterCounter = range.newStartLine

    const diffLines = lines.map(text => {
      // the unified patch format considers these lines to be headers
      // -> exclude them from the line counts
      if (text.startsWith('@@')) {
        return new DiffLine(text, DiffLineType.Hunk, null, null)
      }

      const type = DiffSection.mapToDiffLineType(text)

      if (type === DiffLineType.Delete) {
        rollingDiffBeforeCounter = rollingDiffBeforeCounter + 1

        return new DiffLine(text, type, rollingDiffBeforeCounter, null)
      } else if (type === DiffLineType.Add) {
        rollingDiffAfterCounter = rollingDiffAfterCounter + 1

        return new DiffLine(text, type, null, rollingDiffAfterCounter)
      } else {
        rollingDiffBeforeCounter = rollingDiffBeforeCounter + 1
        rollingDiffAfterCounter = rollingDiffAfterCounter + 1

        return new DiffLine(text, type, rollingDiffBeforeCounter, rollingDiffAfterCounter)
      }
    })

    this.lines = diffLines
  }
}

/** the contents of a diff generated by Git */
export class Diff {
   public readonly sections: ReadonlyArray<DiffSection>

   public constructor(sections: DiffSection[]) {
     this.sections = sections
   }

   public setAllLines(include: boolean) {
     this.sections
        .forEach(section => {
          section.lines.forEach(line => {
            if (line.type === DiffLineType.Add || line.type === DiffLineType.Delete) {
              line.selected = include
            }
          })
        })
   }
}

export enum BranchType {
  Local,
  Remote,
}

/** A branch as loaded from Git. */
export class Branch {
  /** The short name of the branch. E.g., `master`. */
  public readonly name: string

  /** The origin-prefixed upstream name. E.g., `origin/master`. */
  public readonly upstream: string | null

  /** The SHA for the tip of the branch. */
  public readonly sha: string

  /** The type of branch, e.g., local or remote. */
  public readonly type: BranchType

  public constructor(name: string, upstream: string | null, sha: string, type: BranchType) {
    this.name = name
    this.upstream = upstream
    this.sha = sha
    this.type = type
  }
}

/**
 * Interactions with a local Git repository
 */
export class LocalGitOperations {

  /**
   * map the raw status text from Git to an app-friendly value
   * shamelessly borrowed from GitHub Desktop (Windows)
   */
  private static mapStatus(rawStatus: string): FileStatus {

    const status = rawStatus.trim()

    if (status === 'M') { return FileStatus.Modified }      // modified
    if (status === 'A') { return FileStatus.New }           // added
    if (status === 'D') { return FileStatus.Deleted }       // deleted
    if (status === 'R') { return FileStatus.Renamed }       // renamed
    if (status === 'RM') { return FileStatus.Renamed }      // renamed in index, modified in working directory
    if (status === 'RD') { return FileStatus.Conflicted }   // renamed in index, deleted in working directory
    if (status === 'DD') { return FileStatus.Conflicted }   // Unmerged, both deleted
    if (status === 'AU') { return FileStatus.Conflicted }   // Unmerged, added by us
    if (status === 'UD') { return FileStatus.Conflicted }   // Unmerged, deleted by them
    if (status === 'UA') { return FileStatus.Conflicted }   // Unmerged, added by them
    if (status === 'DU') { return FileStatus.Conflicted }   // Unmerged, deleted by us
    if (status === 'AA') { return FileStatus.Conflicted }   // Unmerged, added by both
    if (status === 'UU') { return FileStatus.Conflicted }   // Unmerged, both modified
    if (status === '??') { return FileStatus.New }          // untracked

    return FileStatus.Modified
  }

  /**
   *  Retrieve the status for a given repository,
   *  and fail gracefully if the location is not a Git repository
   */
  public static getStatus(repository: Repository): Promise<StatusResult> {
    return GitProcess.execWithOutput([ 'status', '--untracked-files=all', '--porcelain' ], repository.path)
        .then(output => {
            const lines = output.split('\n')

            const regex = /([\? \w]{2}) (.*)/
            const regexGroups = { mode: 1, path: 2 }

            const files = new Array<WorkingDirectoryFileChange>()

            for (const index in lines) {
              const line = lines[index]
              const result = regex.exec(line)

              if (result) {
                const modeText = result[regexGroups.mode]
                const path = result[regexGroups.path]

                const status = this.mapStatus(modeText)
                const diffSelection = new DiffSelection(true, new Map<number, boolean>())
                files.push(new WorkingDirectoryFileChange(path, status, diffSelection))
              }
            }

            return StatusResult.FromStatus(new WorkingDirectoryStatus(files, true))
        })
        .catch(error => {
          if (error) {
            const gitError = error as GitError
            if (gitError) {
              const code = gitError.errorCode
              if (code === GitErrorCode.NotFound) {
                return StatusResult.NotFound()
              }
              throw new Error('unable to resolve HEAD, got error code: ' + code)
            }
          }

          throw new Error('unable to resolve status, got unknown error: ' + error)
        })
  }

  private static async resolveHEAD(repository: Repository): Promise<boolean> {
    return GitProcess.execWithOutput([ 'show', 'HEAD' ], repository.path)
      .then(output => {
        return Promise.resolve(true)
      })
      .catch(error => {
        if (error) {

          const gitError = error as GitError
          if (gitError) {
              const code = gitError.errorCode
              if (code === GitErrorCode.NotFound) {
                return Promise.resolve(false)
              }
              throw new Error('unable to resolve HEAD, got error code: ' + code)
            }
         }

        throw new Error('unable to resolve HEAD, got unknown error: ' + error)
      })
  }

  private static addFileToIndex(repository: Repository, file: WorkingDirectoryFileChange): Promise<void> {
    let addFileArgs: string[] = []

    if (file.status === FileStatus.New) {
      addFileArgs = [ 'add', file.path ]
    } else {
      addFileArgs = [ 'add', '-u', file.path ]
    }

    return GitProcess.exec(addFileArgs, repository.path)
  }

  private static createPatchForNewFile(file: WorkingDirectoryFileChange, diff: Diff): string {

    const selection = file.diffSelection.selectedLines

    let input: string = ''

    diff.sections.map(s => {

      let linesCounted: number = 0
      let patchBody: string = ''

      s.lines
        .slice(1, s.lines.length - 1) // ignore the header
        .forEach((line, i) => {
          if (line.type === DiffLineType.Context) {
            patchBody += line.text + '\n'
          } else {
            const index = i + 1 // inner list is now off-by-one
            if (selection.has(index)) {
              const include = selection.get(index)
              if (include) {
                patchBody += line.text + '\n'
                linesCounted += 1
              }
            }
          }
        })

      const header = s.lines[0]
      const headerText = header.text
      const additionalTextIndex = headerText.lastIndexOf('@@')
      const additionalText = headerText.substring(additionalTextIndex + 2)

      const newLineCount = linesCounted

      const patchHeader: string = `--- /dev/null\n+++ b/${file.path}\n@@ -${s.range.oldStartLine},${s.range.oldEndLine} +${s.range.newStartLine},${newLineCount} @@ ${additionalText}\n`

      input += patchHeader + patchBody
    })

    return input
  }

  private static async applyPatchToIndex(repository: Repository, file: WorkingDirectoryFileChange): Promise<void> {
    const applyArgs: string[] = [ 'apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-' ]

    const diff = await LocalGitOperations.getDiff(repository, file, null)
    const selection = file.diffSelection.selectedLines

    if (file.status === FileStatus.New) {
      const input = await LocalGitOperations.createPatchForNewFile(file, diff)
      return GitProcess.exec(applyArgs, repository.path, input).then(() => { })
    }

    const tasks = diff.sections.map(s => {

      let linesSkipped: number = 0
      let patchBody: string = ''

      s.lines
        .slice(1, s.lines.length - 1) // ignore the header
        .forEach((line, i) => {
          if (line.type === DiffLineType.Context) {
            patchBody += line.text + '\n'
          } else {
            const index = i + 1 // inner list is now off-by-one
            if (selection.has(index)) {
              const include = selection.get(index)
              if (include) {
                patchBody += line.text + '\n'
              } else if (line.type === DiffLineType.Delete) {
                // need to generate the correct patch here
                patchBody += ' ' + line.text.substr(1, line.text.length - 1) + '\n'
                linesSkipped -= 1
              } else {
                // ignore this line when creating the patch
                linesSkipped += 1
              }
            }
          }
        })

      const header = s.lines[0]
      const headerText = header.text
      const additionalTextIndex = headerText.lastIndexOf('@@')
      const additionalText = headerText.substring(additionalTextIndex + 2)

      const newLineCount = s.range.oldEndLine - linesSkipped

      // TODO: a new file here will have no path defined for ---
      // TODO: handle deleting of a full file

      const patchHeader: string = `--- a/${file.path}\n+++ b/${file.path}\n@@ -${s.range.oldStartLine},${s.range.oldEndLine} +${s.range.newStartLine},${newLineCount} @@ ${additionalText}\n`

      const input = patchHeader + patchBody

      return GitProcess.exec(applyArgs, repository.path, input)
    })

    return Promise.all(tasks).then(() => { })
  }

  public static createCommit(repository: Repository, summary: string, description: string, files: ReadonlyArray<WorkingDirectoryFileChange>) {
    return this.resolveHEAD(repository)
      .then(result => {
        let resetArgs = [ 'reset' ]
        if (result) {
          resetArgs = resetArgs.concat([ 'HEAD', '--mixed' ])
        }

        return resetArgs
      })
      .then(resetArgs => {
        // reset the index
        return GitProcess.exec(resetArgs, repository.path)
          .then(_ => {
            const addFiles = files.map((file, index, array) => {
              if (file.diffSelection.isIncludeAll() === true) {
                return this.addFileToIndex(repository, file)
              } else {
                return this.applyPatchToIndex(repository, file)
              }
            })

            // TODO: pipe standard input into this command
            return Promise.all(addFiles)
              .then(() => {
                let message = summary
                if (description.length > 0) {
                  message = `${summary}\n\n${description}`
                }

                return GitProcess.exec([ 'commit', '-m',  message ] , repository.path)
              })
          })
        })
      .catch(error => {
          console.error('createCommit failed: ' + error)
      })
  }

  /**
    * Render the diff for a file within the repository
    *
    * A specific commit related to the file may be provided, otherwise the
    * working directory state will be used.
    */
  public static getDiff(repository: Repository, file: FileChange, commit: Commit | null): Promise<Diff> {

    let args: string[]

    if (commit) {
      args = [ 'show', commit.sha, '--patch-with-raw', '-z', '--', file.path ]
    } else if (file.status === FileStatus.New) {
      args = [ 'diff', '--no-index', '--patch-with-raw', '-z', '--', '/dev/null', file.path ]
    } else {
      args = [ 'diff', 'HEAD', '--patch-with-raw', '-z', '--', file.path ]
    }

    return GitProcess.execWithOutput(args, repository.path)
      .then(result => {
        const lines = result.split('\0')

        const sectionRegex = /^@@ -(\d+)(,+(\d+))? \+(\d+)(,(\d+))? @@ ?(.*)$/m
        const regexGroups = { oldFileStart: 1, oldFileEnd: 3, newFileStart: 4, newFileEnd: 6 }

        const diffText = lines[lines.length - 1]

        const diffSections = new Array<DiffSection>()

        // track the remaining text in the raw diff to parse
        let diffTextBuffer = diffText
        // each diff section starts with these two characters
        let sectionPrefixIndex = diffTextBuffer.indexOf('@@')
        // continue to iterate while these sections exist
        let prefixFound = sectionPrefixIndex > -1

        let pointer: number = 0

        while (prefixFound) {

          // trim any preceding text
          diffTextBuffer = diffTextBuffer.substr(sectionPrefixIndex)

          // extract the diff section numbers
          const match = sectionRegex.exec(diffTextBuffer)

          let oldStartLine: number = -1
          let oldEndLine: number = -1
          let newStartLine: number = -1
          let newEndLine: number = -1

          if (match) {
            const first = match[regexGroups.oldFileStart]
            oldStartLine = parseInt(first, 10)
            const second = match[regexGroups.oldFileEnd]
            oldEndLine = parseInt(second, 10)
            const third = match[regexGroups.newFileStart]
            newStartLine = parseInt(third, 10)
            const fourth = match[regexGroups.newFileEnd]
            newEndLine = parseInt(fourth, 10)
          }

          const range = new DiffSectionRange(oldStartLine, oldEndLine, newStartLine, newEndLine)

          // re-evaluate whether other sections exist to parse
          const endOfThisLine = diffTextBuffer.indexOf('\n')
          sectionPrefixIndex = diffTextBuffer.indexOf('@@', endOfThisLine + 1)
          prefixFound = sectionPrefixIndex > -1

          // add new section based on the remaining text in the raw diff
          if (prefixFound) {
            const diffBody = diffTextBuffer.substr(0, sectionPrefixIndex)

            let startDiffSection: number = 0
            let endDiffSection: number = 0

            const diffLines = diffBody.split('\n')

            if (diffSections.length === 0) {
              startDiffSection = 0
              endDiffSection = diffLines.length
            } else {
              startDiffSection = pointer + 1
              endDiffSection = startDiffSection + diffLines.length
            }

            pointer += diffLines.length

            diffSections.push(new DiffSection(range, diffLines, startDiffSection, endDiffSection))
          } else {
            const diffBody = diffTextBuffer

            let startDiffSection: number = 0
            let endDiffSection: number = 0

            const diffLines = diffBody.split('\n')

            if (diffSections.length === 0) {
              startDiffSection = 0
              endDiffSection = diffLines.length
            } else {
              startDiffSection = pointer
              endDiffSection = startDiffSection + diffLines.length
            }

            diffSections.push(new DiffSection(range, diffLines, startDiffSection, endDiffSection))
          }
        }

        return new Diff(diffSections)
      })
  }

  /**
   * Get the repository's history, starting from `start` and limited to `limit`
   */
  public static async getHistory(repository: Repository, start: string, limit: number): Promise<ReadonlyArray<Commit>> {
    const delimiter = '1F'
    const delimeterString = String.fromCharCode(parseInt(delimiter, 16))
    const prettyFormat = [
      '%H', // SHA
      '%s', // summary
      '%b', // body
      '%an', // author name
      '%ae', // author email
      '%aI', // author date, ISO-8601
    ].join(`%x${delimiter}`)

    const out = await GitProcess.execWithOutput([ 'log', start, `--max-count=${limit}`, `--pretty=${prettyFormat}`, '-z', '--no-color' ], repository.path)
    const lines = out.split('\0')
    // Remove the trailing empty line
    lines.splice(-1, 1)

    const commits = lines.map(line => {
      const pieces = line.split(delimeterString)
      const sha = pieces[0]
      const summary = pieces[1]
      const body = pieces[2]
      const authorName = pieces[3]
      const authorEmail = pieces[4]
      const parsedDate = Date.parse(pieces[5])
      const authorDate = new Date(parsedDate)
      return new Commit(sha, summary, body, authorName, authorEmail, authorDate)
    })

    return commits
  }

  /** Get the files that were changed in the given commit. */
  public static async getChangedFiles(repository: Repository, sha: string): Promise<ReadonlyArray<FileChange>> {
    const out = await GitProcess.execWithOutput([ 'show', sha, '--name-status', '--format=format:', '-z' ], repository.path)
    const lines = out.split('\0')
    // Remove the trailing empty line
    lines.splice(-1, 1)

    const files: FileChange[] = []
    for (let i = 0; i < lines.length; i++) {
      const statusText = lines[i]
      const status = this.mapStatus(statusText)
      const name = lines[++i]
      files.push(new FileChange(name, status))
    }

    return files
  }

  /** Look up a config value by name in the repository. */
  public static async getConfigValue(repository: Repository, name: string): Promise<string | null> {
    let output: string | null = null
    try {
      output = await GitProcess.execWithOutput([ 'config', '-z', name ], repository.path)
    } catch (e) {
      // Git exits with 1 if the value isn't found. That's ok, but we'd rather
      // just treat it as null.
      if (e.code !== 1) {
        throw e
      }
    }

    if (!output) { return null }

    const pieces = output.split('\0')
    return pieces[0]
  }

  /** Pull from the remote to the branch. */
  public static pull(repository: Repository, remote: string, branch: string): Promise<void> {
    return GitProcess.exec([ 'pull', remote, branch ], repository.path)
  }

  /** Push from the remote to the branch, optionally setting the upstream. */
  public static push(repository: Repository, remote: string, branch: string, setUpstream: boolean): Promise<void> {
    const args = [ 'push', remote, branch ]
    if (setUpstream) {
      args.push('--set-upstream')
    }

    return GitProcess.exec(args, repository.path)
  }

  /** Get the remote names. */
  private static async getRemotes(repository: Repository): Promise<ReadonlyArray<string>> {
    const lines = await GitProcess.execWithOutput([ 'remote' ], repository.path)
    return lines.split('\n')
  }

  /** Get the name of the default remote. */
  public static async getDefaultRemote(repository: Repository): Promise<string | null> {
    const remotes = await LocalGitOperations.getRemotes(repository)
    if (remotes.length === 0) {
      return null
    }

    const index = remotes.indexOf('origin')
    if (index > -1) {
      return remotes[index]
    } else {
      return remotes[0]
    }
  }

  /** Get the name of the current branch. */
  public static async getCurrentBranch(repository: Repository): Promise<Branch | null> {
    try {
      const untrimmedName = await GitProcess.execWithOutput([ 'rev-parse', '--abbrev-ref', 'HEAD' ], repository.path)
      const name = untrimmedName.trim()

      const format = [
        '%(upstream:short)',
        '%(objectname)', // SHA
      ].join('%00')

      const line = await GitProcess.execWithOutput([ 'for-each-ref', `--format=${format}`, `refs/heads/${name}` ], repository.path)
      const pieces = line.split('\0')
      const upstream = pieces[0]
      const sha = pieces[1].trim()
      return new Branch(name, upstream.length > 0 ? upstream : null, sha, BranchType.Local)
    } catch (e) {
      // Git exits with 1 if there's the branch is unborn. We should do more
      // specific error parsing than this, but for now it'll do.
      if (e.code !== 1) {
        throw e
      }
      return null
    }
  }

  /** Get the number of commits in HEAD. */
  public static async getCommitCount(repository: Repository): Promise<number> {
    try {
      const count = await GitProcess.execWithOutput([ 'rev-list', '--count', 'HEAD' ], repository.path)
      return parseInt(count.trim(), 10)
    } catch (e) {
      // Git exits with 1 if there's the branch is unborn. We should do more
      // specific error parsing than this, but for now it'll do.
      if (e.code !== 1) {
        throw e
      }
      return 0
    }
  }

  /** Get all the branches. */
  public static async getBranches(repository: Repository, prefix: string, type: BranchType): Promise<ReadonlyArray<Branch>> {
    const format = [
      '%(refname:short)',
      '%(upstream:short)',
      '%(objectname)', // SHA
    ].join('%00')
    const names = await GitProcess.execWithOutput([ 'for-each-ref', `--format=${format}`, prefix ], repository.path)
    const lines = names.split('\n')

    // Remove the trailing newline
    lines.splice(-1, 1)

    const branches = lines.map(line => {
      const pieces = line.split('\0')
      const name = pieces[0]
      const upstream = pieces[1]
      const sha = pieces[2]
      return new Branch(name, upstream.length > 0 ? upstream : null, sha, type)
    })

    return branches
  }

  /** Create a new branch from the given start point. */
  public static createBranch(repository: Repository, name: string, startPoint: string): Promise<void> {
    return GitProcess.exec([ 'branch', name, startPoint ], repository.path)
  }

  /** Check out the given branch. */
  public static checkoutBranch(repository: Repository, name: string): Promise<void> {
    return GitProcess.exec([ 'checkout', name, '--' ], repository.path)
  }

  /** Get the `limit` most recently checked out branches. */
  public static async getRecentBranches(repository: Repository, branches: ReadonlyArray<Branch>, limit: number): Promise<ReadonlyArray<Branch>> {
    const branchesByName = branches.reduce((map, branch) => map.set(branch.name, branch), new Map<string, Branch>())

    // "git reflog show" is just an alias for "git log -g --abbrev-commit --pretty=oneline"
    // but by using log we can give it a max number which should prevent us from balling out
    // of control when there's ginormous reflogs around (as in e.g. github/github).
    const regex = new RegExp(/.*? checkout: moving from .*? to (.*?)$/i)
    const output = await GitProcess.execWithOutput([ 'log', '-g', '--abbrev-commit', '--pretty=oneline', 'HEAD', '-n', '2500' ], repository.path)
    const lines = output.split('\n')
    const names = new Set<string>()
    for (const line of lines) {
      const result = regex.exec(line)
      if (result && result.length === 2) {
        const branchName = result[1]
        names.add(branchName)
      }

      if (names.size === limit) {
        break
      }
    }

    const recentBranches = new Array<Branch>()
    for (const name of names) {
      const branch = branchesByName.get(name)
      if (!branch) {
        // This means the recent branch has been deleted. That's fine.
        continue
      }

      recentBranches.push(branch)
    }

    return recentBranches
  }

  /** Get the commit for the given ref. */
  public static async getCommit(repository: Repository, ref: string): Promise<Commit | null> {
    const commits = await LocalGitOperations.getHistory(repository, ref, 1)
    if (commits.length < 1) { return null }

    return commits[0]
  }

  /** Is the path a git repository? */
  public static async isGitRepository(path: string): Promise<boolean> {
    try {
      await GitProcess.exec([ 'rev-parse', '--git-dir' ], path)
      return true
    } catch (e) {
      return false
    }
  }

  /** Init a new git repository in the given path. */
  public static initGitRepository(path: string): Promise<void> {
    return GitProcess.exec([ 'init' ], path)
  }
}
