import artifact from "@actions/artifact";
import { debug, getInput, setFailed, setOutput, info } from "@actions/core";
import { exec } from "@actions/exec";
import { context } from "@actions/github";
import { mkdirP } from "@actions/io";
import fs from "fs";
import { Library } from "./h5p/types/library";
import { getFilename, getVersionString } from "./utils";

const options = {
  depListFilePath: "h5p-dependency-list-file",
};

const outputs = {
  filePath: "filePath",
  version: "version",
};

async function run(): Promise<void> {
  try {
    const projectName = context.repo.repo;

    info(`Creating directory '${projectName}' in ${__dirname}`);
    await mkdirP(`${__dirname}/${projectName}`);
    await moveAllFilesButDirectoryIntoDirectory(projectName);

    const fallbackDepListFilePath = "build_info/repos";
    const dependencyListFilePath =
      getInput(options.depListFilePath) ?? fallbackDepListFilePath;

    const useFallbackDepListFilePath =
      fallbackDepListFilePath === dependencyListFilePath;

    const dependencyListFileExists = fs.existsSync(dependencyListFilePath);
    if (dependencyListFileExists) {
      cloneDependencies(projectName, dependencyListFilePath);
    } else if (useFallbackDepListFilePath) {
      debug(`Could not find an H5P dependency file.`);
    } else {
      setFailed(
        `The provided H5P dependency file '${dependencyListFilePath}' could not be found.
         If it doesn't exist, please remove \`${options.depListFilePath}\` from the configuration.`,
      );
      return;
    }

    await npmBuildProjects();

    const library = await getLibraryContents(projectName);
    if (!library) {
      return;
    }

    const version = getVersionString(library);
    const filename = getFilename(projectName, version);
    await packH5P(projectName, filename);

    await archiveH5PPack(filename);

    setOutput(outputs.filePath, filename);
    setOutput(outputs.version, version);
  } catch (error) {
    if (error instanceof Error) {
      setFailed(error.message);
    } else {
      setFailed((error as Object).toString());
    }
  }
}

async function moveAllFilesButDirectoryIntoDirectory(
  destinationDirectory: string,
): Promise<void> {
  const contents = await fs.promises.readdir(__dirname);
  const contentsExceptDestDir = contents.filter(
    fileOrDir => fileOrDir !== destinationDirectory,
  );

  info(`Contents: ${JSON.stringify(contents)}`);

  // Move everything into the project directory.
  // When doing this, the current project gets the
  // same structure as the dependencies. This is
  // crucial for the `h5p pack` command.
  await Promise.all(
    contentsExceptDestDir.map(async fileOrDir => {
      info(`Moving ${fileOrDir} into ${destinationDirectory}`);
      await fs.promises.rename(
        `${__dirname}/${fileOrDir}`,
        `${__dirname}/${destinationDirectory}/${fileOrDir}`,
      );
    }),
  );
}

async function cloneDependencies(
  projectName: string,
  dependencyListFilePath: string,
): Promise<void> {
  info(`Cloning dependencies from '${dependencyListFilePath}'`);

  const dependencyFile = (
    await fs.promises.readFile(
      `${__dirname}/${projectName}/dependencyListFilePath`,
    )
  ).toString("utf-8");

  const dependencies = dependencyFile.split("\n");
  info(`Dependencies: ${JSON.stringify(dependencies)}`);

  Promise.all(
    dependencies.map(async dependency => {
      await exec(`git clone ${dependency}`);
    }),
  );
}

async function npmBuildProjects(): Promise<void> {
  info("Building projects");

  const projects = await fs.promises.readdir(__dirname);
  for (const project of projects) {
    const projectPath = `${__dirname}/${project}`;
    const isNodeProject = fs.existsSync(`${projectPath}/package.json`);
    if (isNodeProject) {
      await exec(`pushd ${project}`);
      await exec("npm install");
      await exec("npm run build --if-present");
      await exec("popd");
    }
  }
}

async function getLibraryContents(
  projectName: string,
): Promise<Library | null> {
  info("Fetching library contents");

  const libraryPath = `${__dirname}/${projectName}/library.json`;
  const libraryExists = fs.existsSync(libraryPath);
  if (!libraryExists) {
    setFailed(`Could not find \`${libraryPath}\`.`);
    return null;
  }

  const libraryJson = (await fs.promises.readFile(libraryPath)).toString(
    "utf-8",
  );
  return JSON.parse(libraryJson) as Library;
}

async function packH5P(projectName: string, filename: string): Promise<void> {
  info(`Packing H5P into file '${filename}'`);

  await exec("npm install -g h5p");
  await exec(`h5p pack -r ${projectName} ${filename}`);
  await exec(`h5p validate ${filename}`);
}

async function archiveH5PPack(filename: string): Promise<void> {
  info(`Archiving H5P into file '${filename}'`);

  const artifactClient = artifact.create();
  await artifactClient.uploadArtifact(filename, [filename], ".");
}

run();
