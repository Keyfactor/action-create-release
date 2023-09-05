const core = require('@actions/core');
const { context } = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const { owner, repo } = context.repo;
const semver = require('semver');
const process = require('process');
const octokit = new Octokit(process.env.GITHUB_TOKEN);
const Scheme = {
  Continuous: 'continuous',
  Semantic: 'semantic'
};
const Semantic = {
  Major: 'major',
  Minor: 'minor',
  Patch: 'patch',
  Premajor: 'premajor',
  Preminor: 'preminor',
  Prepatch: 'prepatch',
  Prerelease: 'prerelease'
};
const prerelease = core.getInput('prerelease', { required: false }) === 'true';
const releaseName = core.getInput('release_name') || process.env.RELEASE_NAME;
const patchVersion = core.getInput('patch_version') || process.env.PATCH_VERSION;
// Check string is null
function isNullString(string) {
  return !string || string.length === 0 || string === 'null' || string === 'undefined';
}

// If there is no previous tag, Then the intial tag will be used
function initialTag(tag) {
  const suffix = core.getInput('prerelease_suffix');
  const newTag = prerelease ? `${tag}-${suffix}.0` : tag;

  return newTag;
}

// Filter the existing tags/refs on the version core.getInput('release_name')
async function existingTags() {
  console.log(`Getting existing tags for ${patchVersion} on ${owner}/${repo}...`);

  const { data: refs } = await octokit.rest.git.listMatchingRefs({
    owner,
    repo,
    ref: 'tags'
  });
  const filteredTags = refs.filter(obj => obj.ref.includes(`refs/tags/${patchVersion}`)).reverse();
  console.log(`Latest filteredTag refs[0]:${filteredTags[0]}`)
  return filteredTags
}

function semanticVersion(tag) {
  try {
    const [version, pre] = tag.split('-', 2);
    const sem = semver.parse(semver.coerce(version));

    if (!isNullString(pre)) {
      sem.prerelease = semver.prerelease(`0.0.0-${pre}`);
    }

    return sem;
  } catch (_) {
    // semver will return null if it fails to parse, maintain this behavior in our API
    return null;
  }
}

function determineContinuousBumpType(semTag) {
  const type = core.getInput('auto_increment_type') || Semantic.Major;
  const hasExistingPrerelease = semTag.prerelease.length > 0;

  switch (type) {
    case Semantic.Prerelease:
      return hasExistingPrerelease ? Semantic.Prerelease : Semantic.Premajor;
    case Semantic.Premajor:
      return Semantic.Premajor;
    default:
      return Semantic.Major;
  }
}

function determinePrereleaseName(semTag) {
  if (semTag.prerelease.length > 0) {
    return semTag.prerelease[0];
  }
  return core.getInput('prerelease_suffix') || 'beta';
}

function computeNextContinuous(semTag) {
  const bumpType = determineContinuousBumpType(semTag);
  const preName = determinePrereleaseName(semTag);
  const nextSemTag = semver.parse(semver.inc(semTag, bumpType, preName));
  const tagSuffix = nextSemTag.prerelease.length > 0 ? `-${nextSemTag.prerelease.join('.')}` : '';
  return [semTag.options.tagPrefix, nextSemTag.major, tagSuffix].join('');
}

function computeNextSemantic(semTag) {
  try {
    const type = core.getInput('auto_increment_type') || Semantic.Patch;
    const preName = determinePrereleaseName(semTag);

    switch (type) {
      case Semantic.Major:
      case Semantic.Minor:
      case Semantic.Patch:
      case Semantic.Premajor:
      case Semantic.Preminor:
      case Semantic.Prepatch:
      case Semantic.Prerelease:
        console.log(`running semver using: semtag=${semTag}, type=${type}, preName=${preName}`)
        return `${semTag.options.tagPrefix}${semver.inc(semTag, type, preName)}`;
      default:
        core.setFailed(
          `Unsupported semantic version type ${type}. Must be one of (${Object.values(Semantic).join(', ')})`
        );
    }
  } catch (error) {
    core.setFailed(`Failed to compute next semantic tag: ${error}`);
  }
  return null;
}

async function computeLastTag() {
  const recentTags = await existingTags();
  if (recentTags.length < 1) {
    return null;
  }
  core.info(`computeLastTag most recentTag ref: ${recentTags[0].ref}`);
  return recentTags.shift().ref.replace('refs/tags/', '');
}

async function computeNextTag(scheme) {
  const lastTag = await computeLastTag();

  // Handle zero-state where no tags exist for the repo
  if (!lastTag) {
    if (scheme === Scheme.Continuous) {
      return initialTag('v1');
    }
    return initialTag('v1.0.0');
  }
  core.info(`Computing the next tag based on: ${lastTag}`);
  core.setOutput('previous_tag', lastTag);

  const semTag = semanticVersion(lastTag);
  console.log(`lastTag: ${lastTag}`)
  console.log(`semTag: ${semTag}`)
  // console.log(`scheme: ${scheme}`)
  if (semTag == null) {
    core.setFailed(`Failed to parse tag: ${lastTag}`);
    return null;
  }
  semTag.options.tagPrefix = lastTag.startsWith('v') ? 'v' : '';

  if (scheme === Scheme.Continuous) {
    return computeNextContinuous(semTag);
  }
  console.log(`Run computeNextSemantic using ${semTag}`)
  return computeNextSemantic(semTag);
}

async function run() {
  try {
    // Get the inputs from the workflow file: https://github.com/actions/toolkit/tree/master/packages/core#inputsoutputs
    const tagName = core.getInput('tag_name', { required: false });
    const scheme = core.getInput('tag_schema', { required: false });
    if (scheme !== Scheme.Continuous && scheme !== Scheme.Semantic) {
      core.setFailed(`Unsupported version scheme: ${scheme}`);
      return;
    }
    console.log(`tagName = ${tagName}`);
    console.log(`scheme = ${scheme}`);
    //console.log('The current release version is ' + core.getInput('release_name'));
    // Use predefined tag or calculate automatic next tag
    const tag = isNullString(tagName) ? await computeNextTag(scheme) : tagName.replace('refs/tags/', '');
    console.log(`tagName = ${tag}`);

    const releaseName = core.getInput('release_name', { required: false });
    const release = isNullString(releaseName) ? tag : releaseName.replace('refs/tags/', '');

    const body = core.getInput('body', { required: false });
    const draft = core.getInput('draft', { required: false }) === 'true';
    const commitish = core.getInput('commitish', { required: false }) || context.sha;
    console.log('consts from getInput set')
    // Create a release
    // API Documentation: https://developer.github.com/v3/repos/releases/#create-a-release
    // Octokit Documentation: https://octokit.github.io/rest.js/#octokit-routes-repos-create-release
    const createReleaseResponse = await octokit.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: release,
      body,
      draft,
      prerelease,
      target_commitish: commitish
    });

    // Get the ID, html_url, and upload URL for the created Release from the response
    const {
      data: { id: releaseId, html_url: htmlUrl, upload_url: uploadUrl }
    } = createReleaseResponse;

    // Set the output variables for use by other actions: https://github.com/actions/toolkit/tree/master/packages/core#inputsoutputs
    core.setOutput('current_tag', tag);
    core.setOutput('id', releaseId);
    core.setOutput('html_url', htmlUrl);
    core.setOutput('upload_url', uploadUrl);
  } catch (error) {
    core.setFailed(error.message);
  }
}

module.exports = run;
