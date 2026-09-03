function extractSinglePackageReport(report) {
  let packageReport;

  if (Array.isArray(report)) {
    if (report.length !== 1) {
      throw new Error("npm pack report must contain exactly one package.");
    }
    [packageReport] = report;
  } else if (report && typeof report === "object") {
    const packageReports = Object.values(report);
    if (packageReports.length !== 1) {
      throw new Error("npm pack report must contain exactly one package.");
    }
    [packageReport] = packageReports;
  } else {
    throw new Error("npm pack report has an unsupported format.");
  }

  if (!packageReport || typeof packageReport !== "object") {
    throw new Error("npm pack report does not contain a valid package entry.");
  }

  return packageReport;
}

export function extractPackageFiles(report) {
  const packageReport = extractSinglePackageReport(report);

  if (!Array.isArray(packageReport.files)) {
    throw new Error("npm pack report does not contain a valid files list.");
  }

  return packageReport.files.map((file) => {
    if (!file || typeof file !== "object" || typeof file.path !== "string") {
      throw new Error("npm pack report contains an invalid file entry.");
    }
    return file.path;
  }).sort();
}

export function extractPackageArchiveName(report) {
  const archiveName = extractSinglePackageReport(report).filename;
  if (typeof archiveName !== "string" || !archiveName.endsWith(".tgz")) {
    throw new Error("npm pack did not report a package archive.");
  }
  return archiveName;
}
