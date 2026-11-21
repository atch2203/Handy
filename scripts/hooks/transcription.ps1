<#
.SYNOPSIS
    Handy transcription hook: turns a spoken token into a period.

.DESCRIPTION
    Handy writes the text it is about to paste to this script's stdin and
    pastes what the script writes to stdout. This script:

      1. Deletes every "." the speech model inserted, except a "." with a
         digit directly on both sides. Measurements survive: "2.5 cm" stays
         "2.5 cm". This is a clinical-safety rule; never loosen it to delete
         every period, or "2.5 cm" becomes "25 cm".
      2. Then replaces the spoken token (by default "{period}") with ".",
         removing any whitespace before the token. Step 2 runs after step 1
         so the periods it inserts are not deleted.
      3. Collapses runs of spaces into one and trims the ends.
      4. Optionally capitalises the first letter after an inserted period.

    INSTALL: copy this file to %APPDATA%\com.pais.handy\hooks\transcription.ps1
    (create the "hooks" folder if needed). Check it with:

        powershell -NoProfile -ExecutionPolicy Bypass -File transcription.ps1 -SelfTest

    CHECK THE TOKEN WITH YOUR SPEECH MODEL. The default "{period}" matches a
    medical speech model that writes "{period}" when you say "period" and
    adds periods of its own elsewhere. Other models may write "." for a
    spoken "period", which step 1 then deletes. Dictate a test sentence, open
    Handy's History tab (it stores the text from before this hook) and see
    what the model wrote. If it isn't "{period}", set $TokenPattern below to
    match, for example for a spoken "full stop":

        $TokenPattern = '\bfull\s+stop\b'

    Requires Windows PowerShell 5.1 or later.
#>
param(
    [switch]$SelfTest
)

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

# Regex for the spoken token that becomes a period. Matched case-insensitively.
# Default: "{period}", allowing spaces inside the braces ("{ period }").
$TokenPattern = '\{\s*period\s*\}'

# $true: capitalise the first letter after each inserted period.
$CapitalizeAfterPeriod = $true

# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

# A "." without a digit on both sides: "2.5" keeps its period, "end." does not.
$StrayPeriodPattern = '(?<!\d)\.|\.(?!\d)'

# Stands in for an inserted period until the end, so later steps can tell
# inserted periods apart. A private-use character never appears in dictation.
$Marker = [string][char]0xE000

function Convert-Dictation {
    param(
        [string]$Text,
        [bool]$Capitalize = $CapitalizeAfterPeriod
    )
    if ([string]::IsNullOrEmpty($Text)) { return '' }

    $ignoreCase = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase

    # 1. Strip periods the model inserted, keeping decimals.
    $out = [regex]::Replace($Text, $StrayPeriodPattern, '')

    # 2. Token (and the whitespace before it) becomes an inserted period.
    $out = [regex]::Replace($out, '\s*(?:' + $TokenPattern + ')', $Marker, $ignoreCase)

    # 3. Collapse runs of spaces, trim the ends.
    $out = [regex]::Replace($out, ' {2,}', ' ').Trim()

    # 4. Optional: capitalise the next letter after an inserted period.
    if ($Capitalize) {
        $out = [regex]::Replace(
            $out,
            $Marker + '(\s*)(\p{Ll})',
            [System.Text.RegularExpressions.MatchEvaluator] {
                param($m)
                $Marker + $m.Groups[1].Value + $m.Groups[2].Value.ToUpperInvariant()
            }
        )
    }

    return $out.Replace($Marker, '.')
}

if ($SelfTest) {
    # Input, expected output, capitalise.
    $cases = @(
        ,@('the lesion measures 2.5 cm', 'the lesion measures 2.5 cm', $false)
        ,@('value 0.75 and 10.25.', 'value 0.75 and 10.25', $false)
        ,@('no acute findings {period} liver is normal', 'no acute findings. liver is normal', $false)
        ,@('one {period} two {period} three {period}', 'one. two. three.', $false)
        ,@('{period} starts here', '. starts here', $false)
        ,@('ends here {period}', 'ends here.', $false)
        ,@('mixed {Period} case {PERIOD}', 'mixed. case.', $false)
        ,@('spaced { period } token', 'spaced. token', $false)
        ,@('Model wrote this. And this.', 'Model wrote this And this', $false)
        ,@('no periods at all', 'no periods at all', $false)
        ,@('', '', $false)
        ,@('  extra   spaces  here  ', 'extra spaces here', $false)
        ,@('size 3.2 cm {period} stable.', 'size 3.2 cm. stable', $false)
        ,@('end of sentence {period}  next {period} 4.5 mm', 'end of sentence. next. 4.5 mm', $false)
        ,@('first {period} second {period} 3 lesions', 'first. Second. 3 lesions', $true)
        # Non-ASCII built from code points: PowerShell 5.1 reads a .ps1 without a BOM as ANSI.
        ,@("caf$([char]0xE9) {period} $([char]0xE9)lan", "caf$([char]0xE9). $([char]0xC9)lan", $true)
    )

    $failed = 0
    foreach ($case in $cases) {
        $actual = Convert-Dictation -Text $case[0] -Capitalize $case[2]
        if ($actual -cne $case[1]) {
            $failed++
            Write-Host ("FAIL: '{0}' -> '{1}' (expected '{2}')" -f $case[0], $actual, $case[1])
        }
    }
    Write-Host ("{0} of {1} cases passed" -f ($cases.Count - $failed), $cases.Count)
    if ($failed -gt 0) { exit 1 }
    exit 0
}

# UTF-8 without a byte-order mark both ways, so accents and symbols survive.
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$text = [Console]::In.ReadToEnd()
[Console]::Out.Write((Convert-Dictation -Text $text))
