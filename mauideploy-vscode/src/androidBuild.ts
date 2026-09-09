export interface AndroidBuildOptions {
    framework: string;
    configuration: string;
    runtimeIdentifier?: string;
    fastDeployment: boolean;
    forceReinstall: boolean;
    skipCompatibilityAnalyzers?: boolean;
}

export function androidBuildProperties(options: AndroidBuildOptions): string[] {
    const properties = ['-p:AndroidPreserveUserData=true'];
    if (options.configuration.toLowerCase() === 'debug') {
        if (options.runtimeIdentifier) {
            properties.push(`-r ${options.runtimeIdentifier}`);
        }
        properties.push(`-p:EmbedAssembliesIntoApk=${!options.fastDeployment}`);
        if (options.skipCompatibilityAnalyzers) {
            properties.push('-p:EnableTrimAnalyzer=false', '-p:EnableSingleFileAnalyzer=false');
        }
    }
    if (options.forceReinstall) {
        properties.push('-p:MauiDeployForceReinstall=true', '-p:_ReInstall=true');
    }
    return properties;
}

export function androidDeploymentTargets(): string {
    return `<Project>
    <Target Name="MauiDeployPreventBinCompilation" BeforeTargets="CoreCompile"
                    Condition="'$(MauiDeployFromBin)' == 'true'">
        <Error Text="Existing Android build output is incomplete. Use Run or Debug to rebuild before deploying from bin." />
    </Target>
  <Target Name="MauiDeployForceAndroidInstall" BeforeTargets="_GetUploadInputs"
          Condition="'$(MauiDeployForceReinstall)' == 'true'">
    <Delete Files="$(_UploadFlag)" />
  </Target>
  <Target Name="MauiDeployAndroidDeployStarted" BeforeTargets="_Upload"
          Condition="'$(MauiDeployTimingFile)' != ''">
    <WriteLinesToFile File="$(MauiDeployTimingFile)" Lines="deployStart=$([System.DateTime]::UtcNow.Ticks)" Overwrite="true" />
  </Target>
  <Target Name="MauiDeployAndroidDeployFinished" AfterTargets="_Upload"
          Condition="'$(MauiDeployTimingFile)' != ''">
    <WriteLinesToFile File="$(MauiDeployTimingFile)" Lines="deployEnd=$([System.DateTime]::UtcNow.Ticks)" />
  </Target>
</Project>`;
}

export function androidPhaseTimings(started: number, finished: number, timingContent: string): { buildMs: number; deployMs: number } | undefined {
    const timestamps = new Map<string, number>();
    for (const line of timingContent.trim().split(/\r?\n/)) {
        const match = /^(deployStart|deployEnd)=(\d+)$/.exec(line);
        if (match) {
            timestamps.set(match[1], Number(BigInt(match[2]) / 10000n) - 62135596800000);
        }
    }
    const deployStart = timestamps.get('deployStart');
    const deployEnd = timestamps.get('deployEnd');
    if (deployStart === undefined || deployEnd === undefined || deployStart < started || deployEnd < deployStart || deployEnd > finished) {
        return undefined;
    }
    return { buildMs: deployStart - started, deployMs: deployEnd - deployStart };
}