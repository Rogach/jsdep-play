import com.typesafe.sbt.web.SbtWeb
import sbt.Keys._
import sbt._
import scala.sys.process.{Process, ProcessLogger}
import com.typesafe.sbt.web._
import xsbti.{Maybe, Position, Severity, Problem}
import xsbti.CompileFailed
import java.util.regex._

object Import {
  val jsDep =
    TaskKey[Seq[File]]("jsdep", "Process javascript files to wire in rjs & angular dependencies")
}

object SbtJSDep extends AutoPlugin {

  override def requires = SbtWeb

  override def trigger = AllRequirements

  import SbtWeb.autoImport._
  import WebKeys._
  import Import.jsDep

  val baseSettings = Seq(
    resourceManaged in jsDep in Assets := webTarget.value / "js" / "main",
    managedResourceDirectories += (resourceManaged in jsDep in Assets).value,
    resourceGenerators in Assets <+= jsDep in Assets,

    jsDep in Assets := Def.task {
      val sourceDir = file("app/client")
      val targetDir = (resourceManaged in jsDep in Assets).value

      val command = Process(Seq("node", "project/jsdep.js", sourceDir.toString, targetDir.toString, "/"))

      val outputFiles = scala.collection.mutable.ArrayBuffer[File]()
      val errors = scala.collection.mutable.ArrayBuffer[String]()
      val process = command.run(ProcessLogger(
        { (out: String) =>
          if (out.startsWith("***")) {
            println(out)
          } else {
            outputFiles += file(out)
          }
        },
        { (err: String) =>
          errors += err
        }
      ))

      process.exitValue

      errors.foreach { err =>
        val pattern = Pattern.compile("(.*)\\((\\d+),(\\d+)\\):(.*)")
        val m = pattern.matcher(err)
        if (m.matches()) {
          CompileProblems.report((reporter in jsDep).value, Seq(
            new LineBasedProblem(
              message = m.group(4).trim,
              severity = Severity.Error,
              lineNumber = m.group(2).toInt,
              lineContent = "",
              characterOffset = m.group(3).toInt,
              source = new File(m.group(1))
            )
          ))
        } else {
          println("ERR: " + err)
        }
      }

      if (process.exitValue != 0 && errors.isEmpty) {
        errors.foreach(println);
        sys.error("jsdep invocation returned non-zero status: " + process.exitValue)
      }

      outputFiles
    }.dependsOn(WebKeys.webModules in Assets).value
  )

  override def projectSettings: Seq[Setting[_]] = inConfig(Assets)(baseSettings)
}
